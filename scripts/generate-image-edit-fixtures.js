const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUT_DIR = path.join(__dirname, '..', 'assets', 'image-edit');
const SIZE = 1024;

function svg(body, defs = '') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="studio" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4f0e8"/>
      <stop offset="1" stop-color="#d8d3c9"/>
    </linearGradient>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ece9e2"/>
      <stop offset="1" stop-color="#d8d3ca"/>
    </linearGradient>
    <linearGradient id="oak" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#cfa876"/>
      <stop offset="0.5" stop-color="#e6c99f"/>
      <stop offset="1" stop-color="#bf9565"/>
    </linearGradient>
    <radialGradient id="orb" cx="35%" cy="27%" r="70%">
      <stop offset="0" stop-color="#77d4ff"/>
      <stop offset="0.28" stop-color="#146fca"/>
      <stop offset="0.7" stop-color="#073d8c"/>
      <stop offset="1" stop-color="#021c4d"/>
    </radialGradient>
    <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4d47a"/>
      <stop offset="0.35" stop-color="#9d6a20"/>
      <stop offset="0.68" stop-color="#d4a949"/>
      <stop offset="1" stop-color="#6b4214"/>
    </linearGradient>
    ${defs}
  </defs>
  ${body}
</svg>`;
}

function studio(object) {
  return svg(`
    <rect width="1024" height="1024" fill="url(#studio)"/>
    <path d="M0 140C230 40 520 72 1024 0V520C700 590 310 560 0 650Z" fill="#ffffff" opacity="0.23"/>
    <ellipse cx="526" cy="806" rx="245" ry="52" fill="#54493d" opacity="0.2"/>
    <g>${object}</g>
  `);
}

const fixtures = {
  'scene-b.png': svg(`
    <rect width="1024" height="1024" fill="url(#wall)"/>
    <path d="M0 0H430L235 650H0Z" fill="#fff" opacity="0.28"/>
    <path d="M260 0H410L260 650H110Z" fill="#fff" opacity="0.13"/>
    <rect x="0" y="650" width="1024" height="374" fill="#c8c1b6"/>
    <ellipse cx="510" cy="803" rx="470" ry="58" fill="#6b5a48" opacity="0.18"/>
    <g>
      <rect x="62" y="592" width="900" height="76" rx="8" fill="url(#oak)"/>
      <path d="M88 668H144L126 952H92Z" fill="#9b744e"/>
      <path d="M880 668H936L932 952H898Z" fill="#9b744e"/>
      <path d="M98 635C330 617 612 646 929 623" fill="none" stroke="#a97e51" stroke-width="5" opacity="0.55"/>
    </g>
    <g transform="translate(92 366)">
      <path d="M74 194C28 117 27 43 70 7C95 61 106 118 93 190Z" fill="#477c50"/>
      <path d="M86 191C94 95 143 38 197 28C186 97 147 155 104 198Z" fill="#3c7047"/>
      <path d="M83 186C45 142 5 124 0 72C52 86 85 124 98 188Z" fill="#5e9263"/>
      <path d="M102 186C131 126 178 106 220 120C196 164 156 188 112 200Z" fill="#6b9b68"/>
      <path d="M48 190H157L143 282Q138 312 108 316H91Q61 312 57 282Z" fill="#eee9df"/>
      <ellipse cx="102" cy="192" rx="54" ry="14" fill="#d5cec0"/>
    </g>
    <g transform="translate(750 440)">
      <rect x="17" y="146" width="155" height="29" rx="4" fill="#727d7a"/>
      <rect x="0" y="175" width="184" height="34" rx="4" fill="#b2a48d"/>
      <path d="M168 142V18" fill="none" stroke="#242629" stroke-width="15" stroke-linecap="round"/>
      <path d="M168 23L105 69" fill="none" stroke="#242629" stroke-width="15" stroke-linecap="round"/>
      <path d="M93 63L135 55L123 104L76 96Z" fill="#303236"/>
      <ellipse cx="166" cy="211" rx="51" ry="10" fill="#1f2022"/>
    </g>
  `),

  'object-fox.png': studio(`
    <path d="M620 676C739 650 755 544 704 472C692 557 643 586 578 565Z" fill="#b93125"/>
    <ellipse cx="505" cy="599" rx="161" ry="181" fill="#d74432"/>
    <path d="M378 360L410 176L488 351Z" fill="#c9362a"/>
    <path d="M532 350L614 174L640 374Z" fill="#c9362a"/>
    <path d="M401 257L421 211L454 303Z" fill="#6e2925"/>
    <path d="M566 304L606 211L614 290Z" fill="#6e2925"/>
    <path d="M397 350Q505 274 622 362L596 520Q580 610 505 620Q427 610 409 520Z" fill="#e24b38"/>
    <path d="M434 493Q505 441 578 493Q559 574 505 581Q450 574 434 493Z" fill="#f2b894"/>
    <circle cx="456" cy="428" r="16" fill="#241c1b"/>
    <circle cx="553" cy="428" r="16" fill="#241c1b"/>
    <path d="M490 500Q505 488 520 500Q513 519 505 520Q497 519 490 500Z" fill="#2b1d1b"/>
    <path d="M427 723Q505 754 582 723V785H427Z" fill="#b92f25"/>
  `),

  'object-orb.png': studio(`
    <ellipse cx="512" cy="737" rx="132" ry="31" fill="#bad1da" opacity="0.75"/>
    <ellipse cx="512" cy="732" rx="94" ry="19" fill="none" stroke="#eefcff" stroke-width="18" opacity="0.75"/>
    <circle cx="512" cy="484" r="238" fill="url(#orb)" stroke="#06265f" stroke-width="8"/>
    <ellipse cx="438" cy="380" rx="67" ry="104" transform="rotate(35 438 380)" fill="#d8f7ff" opacity="0.58"/>
    <path d="M370 565C450 677 592 688 663 554" fill="none" stroke="#4ba8ed" stroke-width="22" opacity="0.35"/>
  `),

  'object-rocket.png': studio(`
    <path d="M512 174Q626 282 611 515L579 684H445L413 515Q398 282 512 174Z" fill="#d8a520"/>
    <path d="M512 174Q551 256 549 684H512Z" fill="#f1c94b" opacity="0.85"/>
    <path d="M447 566L346 713L442 688Z" fill="#bd7222"/>
    <path d="M577 566L678 713L582 688Z" fill="#bd7222"/>
    <path d="M472 682L421 796H603L552 682Z" fill="#b75d1d"/>
    <circle cx="512" cy="424" r="73" fill="#f0d77c" stroke="#735016" stroke-width="15"/>
    <circle cx="512" cy="424" r="51" fill="#2377a6"/>
    <ellipse cx="491" cy="402" rx="18" ry="26" fill="#b9e8f1" opacity="0.75"/>
    <path d="M455 765L512 872L570 765Z" fill="#ef8b26"/>
  `),

  'object-cactus.png': studio(`
    <path d="M430 607V315Q430 235 512 235Q594 235 594 315V607Z" fill="#3e8253"/>
    <path d="M438 363C484 343 541 343 585 363" fill="none" stroke="#7aaa6e" stroke-width="8" opacity="0.7"/>
    <path d="M474 251V610M512 238V610M550 251V610" stroke="#76a96c" stroke-width="8" opacity="0.5"/>
    <path d="M436 446H367Q326 446 326 398V354Q326 315 366 315Q407 315 407 354V384H436Z" fill="#4b9160"/>
    <path d="M589 507H655Q698 507 698 458V414Q698 374 657 374Q616 374 616 414V444H589Z" fill="#4b9160"/>
    <path d="M355 620H669L633 794Q625 831 586 838H438Q399 831 391 794Z" fill="#b85c35"/>
    <ellipse cx="512" cy="619" rx="157" ry="35" fill="#d67b4d"/>
    <ellipse cx="512" cy="621" rx="126" ry="23" fill="#5b4838"/>
  `),

  'object-robot.png': studio(`
    <rect x="385" y="224" width="254" height="205" rx="29" fill="#aaaeb8"/>
    <path d="M418 224H608L630 271H394Z" fill="#d9dce1" opacity="0.7"/>
    <circle cx="456" cy="322" r="33" fill="#e7a72f" stroke="#4a3b52" stroke-width="13"/>
    <circle cx="568" cy="322" r="33" fill="#e7a72f" stroke="#4a3b52" stroke-width="13"/>
    <rect x="450" y="376" width="124" height="18" rx="9" fill="#5e5866"/>
    <path d="M512 224V177" stroke="#7c7882" stroke-width="16"/>
    <circle cx="512" cy="158" r="25" fill="#d5a52a"/>
    <rect x="363" y="428" width="298" height="286" rx="31" fill="#713e9d"/>
    <rect x="411" y="472" width="202" height="144" rx="14" fill="#9a69bd"/>
    <circle cx="512" cy="545" r="48" fill="#d2b7e5"/>
    <path d="M512 510V550L544 570" fill="none" stroke="#573170" stroke-width="15" stroke-linecap="round"/>
    <path d="M364 479L265 538V652" fill="none" stroke="#a8abb1" stroke-width="45" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M660 479L759 538V652" fill="none" stroke="#a8abb1" stroke-width="45" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M429 714V826M595 714V826" stroke="#a8abb1" stroke-width="55"/>
    <path d="M379 832H479M545 832H645" stroke="#777983" stroke-width="43" stroke-linecap="round"/>
    <path d="M663 548H729M729 548V493M729 493H780" fill="none" stroke="#c6a54c" stroke-width="18" stroke-linecap="round"/>
  `),

  'object-compass.png': studio(`
    <circle cx="512" cy="503" r="254" fill="#5f3f19"/>
    <circle cx="512" cy="489" r="245" fill="url(#brass)" stroke="#6d4516" stroke-width="14"/>
    <circle cx="512" cy="489" r="205" fill="#8d6429" opacity="0.45" stroke="#f4d27b" stroke-width="7"/>
    <path d="M512 306L551 430L678 489L551 548L512 672L473 548L346 489L473 430Z" fill="#5f3c18" stroke="#e3bd62" stroke-width="10"/>
    <circle cx="512" cy="489" r="34" fill="#e1b850" stroke="#6e4617" stroke-width="9"/>
    <path d="M474 247Q512 161 550 247" fill="none" stroke="#8f6423" stroke-width="27"/>
    <circle cx="512" cy="173" r="53" fill="none" stroke="#b88a36" stroke-width="24"/>
    <path d="M356 367Q423 288 512 280" fill="none" stroke="#ffe69b" stroke-width="16" opacity="0.35" stroke-linecap="round"/>
  `),

  'object-mug.png': studio(`
    <path d="M350 302H650L625 710Q620 765 565 775H435Q380 765 375 710Z" fill="#f2eee2" stroke="#292929" stroke-width="12"/>
    <path d="M378 320H419L432 742Q429 762 414 764H405Q392 759 390 731Z" fill="#202124"/>
    <path d="M459 314H501V772H464Q448 766 447 744Z" fill="#202124"/>
    <path d="M542 314H584L575 768H537Z" fill="#202124"/>
    <path d="M623 320H648L625 710Q621 747 600 760Z" fill="#202124"/>
    <path d="M380 335C460 295 555 300 635 335" fill="none" stroke="#fff" stroke-width="17" opacity="0.28"/>
    <ellipse cx="500" cy="302" rx="150" ry="42" fill="#e9e4d8" stroke="#292929" stroke-width="12"/>
    <ellipse cx="500" cy="304" rx="121" ry="27" fill="#333033"/>
    <path d="M641 405Q785 405 780 555Q776 684 640 654" fill="none" stroke="#292929" stroke-width="67" stroke-linecap="round"/>
    <path d="M647 425Q742 427 739 551Q736 632 649 630" fill="none" stroke="#eee9dc" stroke-width="37" stroke-linecap="round"/>
  `)
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, source] of Object.entries(fixtures)) {
  const temp = path.join(OUT_DIR, `${name}.svg`);
  const target = path.join(OUT_DIR, name);
  fs.writeFileSync(temp, source);
  const result = spawnSync('convert', [
    '-background', 'none',
    temp,
    '-depth', '8',
    '-strip',
    target
  ], { encoding: 'utf8' });
  fs.unlinkSync(temp);
  if (result.status !== 0) {
    throw new Error(`convert failed for ${name}: ${result.stderr || result.stdout}`);
  }
}

console.log(`generated ${Object.keys(fixtures).length} fixtures in ${OUT_DIR}`);
