const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const svgCode = `
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" rx="256" fill="#0c1429"/>
  <rect x="24" y="24" width="976" height="976" rx="232" stroke="#2d7ff9" stroke-width="48" stroke-opacity="0.4"/>
  <g transform="translate(160, 160) scale(17.6)">
    <rect x="4" y="15" width="32" height="21" rx="5" stroke="#2d7ff9" stroke-width="4.5" stroke-linejoin="round"/>
    <path d="M11 15V11.5a9 9 0 0 1 18 0V15" stroke="#2d7ff9" stroke-width="4.5" stroke-linecap="round"/>
    <circle cx="20" cy="25.5" r="4.5" fill="#2d7ff9"/>
  </g>
</svg>
`;

const outputPath = path.join(__dirname, 'src', 'frontend', 'icon.png');

sharp(Buffer.from(svgCode))
  .png()
  .toFile(outputPath)
  .then(() => {
    console.log('[SafeBox] Successfully generated icon.png at ' + outputPath);
  })
  .catch((err) => {
    console.error('[SafeBox] Error generating icon:', err);
  });
