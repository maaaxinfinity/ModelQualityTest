#!/usr/bin/env python3
"""
Claude 渠道检测 - 本地服务

  两件事：
    1) 把 index.html / app.js / questions.js / style.css 作为静态站点服务
    2) 暴露 POST /proxy ：接收 {url, method, headers, body, timeout_ms}，
       由本进程发起请求（等同 curl），然后把【完整的响应头 + body + 状态码】
       原样回传给页面。

  为什么需要 /proxy ：
    浏览器的 fetch / XHR 默认只把服务器在响应头 Access-Control-Expose-Headers
    里显式列出的那几个头开放给 JS 读取。4Router 只白名单了 6 个，所以页面
    里 X-4router-Version / X-Amzn-Requestid / X-New-Api-Version / Cf-Ray
    等渠道指纹头通通看不到。把请求绕一手本进程，就完全没有这个限制了，
    所见即所得，跟 curl 一致。

  跑：
      python server.py [端口=8765]
      浏览器打开  http://127.0.0.1:8765/
"""

import http.server
import json
import os
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

# 是否有系统 curl 可用。某些反代（典型如开了 Cloudflare Bot Fight Mode 的）
# 会基于 TLS/JA3 指纹拦截 Python urllib（返回 error code 1010），但放行 curl。
# 检测到 curl 时优先用 curl 发请求，让 TLS 指纹长得像浏览器。
CURL_PATH = shutil.which("curl")

# _fetch_via_curl 在 curl --max-time 触发时返回这个哨兵，调用方据此跳过 urllib fallback
# （上游已经黑洞，再走一次 urllib 只会让总耗时翻倍）
CURL_TIMEOUT_SENTINEL = object()

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
WEBROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEBROOT, **kwargs)

    # 减少静态资源刷屏日志
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_POST(self):
        if self.path == "/proxy":
            return self._proxy()
        if self.path == "/proxy/ping":
            return self._send_json(200, {"ok": True, "version": "1"})
        self.send_error(404)

    def do_GET(self):
        if self.path == "/proxy/ping":
            return self._send_json(200, {"ok": True, "version": "1"})
        return super().do_GET()

    # ───────────── /proxy ─────────────
    def _proxy(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            spec = json.loads(raw.decode("utf-8"))
        except Exception as e:
            return self._send_json(400, {"error": "bad request: %s" % e})

        url = spec.get("url")
        method = (spec.get("method") or "POST").upper()
        in_headers = spec.get("headers") or {}
        body = spec.get("body")
        timeout_ms = int(spec.get("timeout_ms") or 60000)
        verify_tls = bool(spec.get("verify_tls", True))

        if not url:
            return self._send_json(400, {"error": "missing url"})

        if isinstance(body, (dict, list)):
            body_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body_bytes = body.encode("utf-8")
        elif body is None:
            body_bytes = None
        else:
            body_bytes = json.dumps(body).encode("utf-8")

        # 默认带一个真浏览器 UA + Accept-* 头，调用方自己传同名头会覆盖默认值。
        merged_headers = {
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/130.0.0.0 Safari/537.36"),
            "Accept": "application/json, text/event-stream;q=0.9, */*;q=0.5",
            "Accept-Language": "en-US,en;q=0.9",
        }
        merged_headers.update(in_headers)

        # 优先用 curl（绕开 Cloudflare 对 Python urllib 的 JA3 拦截）
        t0 = time.time()
        if CURL_PATH:
            res = self._fetch_via_curl(url, method, merged_headers, body_bytes, timeout_ms, verify_tls)
            if res is CURL_TIMEOUT_SENTINEL:
                # 上游已黑洞：curl --max-time 触发，不再 fallback urllib（只会让总等待翻倍）
                return self._send_json(504, {
                    "error": "upstream timeout",
                    "detail": ("curl 在 %d ms 内一字节未收到。"
                               "通常意味着请求已通过网关校验、被路由到上游 Claude 账号，"
                               "但该账号无响应（账号黑洞 / token 失效 / 上游网络故障）。") % timeout_ms,
                    "elapsedMs": int((time.time() - t0) * 1000),
                })
            if res is not None:
                status, headers, payload = res
            else:
                # curl 其他失败（非超时），回退 urllib
                res2 = self._fetch_via_urllib(url, method, merged_headers, body_bytes, timeout_ms, verify_tls, t0)
                if isinstance(res2, tuple):
                    status, headers, payload = res2
                else:
                    return res2  # 已经 self._send_json
        else:
            res2 = self._fetch_via_urllib(url, method, merged_headers, body_bytes, timeout_ms, verify_tls, t0)
            if isinstance(res2, tuple):
                status, headers, payload = res2
            else:
                return res2

        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            text = payload.decode("utf-8", errors="replace")

        return self._send_json(
            200,
            {
                "status": status,
                "headers": headers,  # [[k, v], ...]  原样、含重复 key、含全部头
                "body": text,
                "elapsedMs": int((time.time() - t0) * 1000),
            },
        )

    # ─────────── fetch backends ───────────
    def _fetch_via_curl(self, url, method, headers, body_bytes, timeout_ms, verify_tls):
        """Returns (status, headers_list, payload_bytes) or None on failure."""
        # 用 -D 把响应头写到 stderr 流方便解析，-o 把 body 写到 stdout
        # --max-time 单位是秒，必须 >=1
        timeout_s = max(1, timeout_ms // 1000)
        cmd = [CURL_PATH, "-sS", "-X", method.upper(),
               "--max-time", str(timeout_s),
               "-D", "-",                  # dump response headers to stdout
               "-o", "-",                  # write body to stdout (after headers, separated by blank line)
               ]
        if not verify_tls:
            cmd.append("-k")
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
        if body_bytes is not None:
            cmd += ["--data-binary", "@-"]
        cmd.append(url)
        try:
            proc = subprocess.run(
                cmd,
                input=body_bytes if body_bytes is not None else b"",
                capture_output=True,
                timeout=timeout_s + 5,
            )
        except Exception as e:
            sys.stderr.write("curl invocation failed: %r\n" % e)
            return None
        if proc.returncode != 0:
            sys.stderr.write("curl exit %d, stderr: %r\n" % (proc.returncode, proc.stderr[:200]))
            if proc.returncode == 28:
                # --max-time 触发；让上层不要再走 urllib 二次等待
                return CURL_TIMEOUT_SENTINEL
            return None

        out = proc.stdout
        # curl 在重定向/100-continue 时可能输出多段 header block；只取最后一段
        # 找最后一个 "\r\n\r\n"（或 "\n\n"）作为 header / body 的分隔
        sep_idx = out.rfind(b"\r\n\r\n")
        if sep_idx < 0:
            sep_idx = out.rfind(b"\n\n")
            sep_len = 2
        else:
            sep_len = 4
        if sep_idx < 0:
            return None
        head_part = out[:sep_idx]
        body_part = out[sep_idx + sep_len:]
        # 多段 header 时拿最后一段（curl 不带 -L 一般只有 1 段，但保险起见）
        head_blocks = head_part.split(b"\r\n\r\n") if b"\r\n\r\n" in head_part else head_part.split(b"\n\n")
        last_head = head_blocks[-1]
        lines = last_head.replace(b"\r\n", b"\n").split(b"\n")
        if not lines:
            return None
        status_line = lines[0].decode("latin-1", errors="replace")
        # "HTTP/1.1 200 OK"
        parts = status_line.split()
        if len(parts) < 2:
            return None
        try:
            status = int(parts[1])
        except ValueError:
            return None
        headers_list = []
        for line in lines[1:]:
            if not line:
                continue
            s = line.decode("latin-1", errors="replace")
            if ":" in s:
                k, _, v = s.partition(":")
                headers_list.append([k.strip(), v.strip()])
        return status, headers_list, body_part

    def _fetch_via_urllib(self, url, method, headers, body_bytes, timeout_ms, verify_tls, t0):
        req = urllib.request.Request(url=url, data=body_bytes, method=method)
        for k, v in headers.items():
            try:
                req.remove_header(k)
            except Exception:
                pass
            req.add_header(k, v)
        ctx = ssl.create_default_context()
        if not verify_tls:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        try:
            with urllib.request.urlopen(req, timeout=timeout_ms / 1000.0, context=ctx) as resp:
                return (resp.status, [[k, v] for k, v in resp.getheaders()], resp.read())
        except urllib.error.HTTPError as e:
            return (e.code, [[k, v] for k, v in e.headers.items()], e.read())
        except urllib.error.URLError as e:
            return self._send_json(502, {
                "error": "URLError",
                "detail": str(e.reason),
                "elapsedMs": int((time.time() - t0) * 1000),
            })
        except socket.timeout:
            return self._send_json(504, {
                "error": "timeout",
                "elapsedMs": int((time.time() - t0) * 1000),
            })
        except Exception as e:
            return self._send_json(500, {
                "error": "proxy internal",
                "detail": repr(e),
                "elapsedMs": int((time.time() - t0) * 1000),
            })

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError) as e:
            # 浏览器在我们写回前已主动断开（常见于 fetch 自己已超时 / 用户点了停止）。
            # 这里写不进去是预期，吞掉就行，别把 socketserver 的栈轨刷到日志。
            sys.stderr.write("client closed before response: %s\n" % e.__class__.__name__)


class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    addr = ("127.0.0.1", PORT)
    with ThreadedServer(addr, Handler) as httpd:
        print("Serving  http://%s:%d/" % addr)
        print("Open that URL in your browser.")
        print("The page will auto-detect /proxy and use it (no header visibility limits).")
        print("Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
