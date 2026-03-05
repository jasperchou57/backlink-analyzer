#!/usr/bin/env node
// Run: node generate-icons.js
// Creates PNG icon files from the SVG

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = [16, 48, 128];

function drawIcon(size) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const s = size;
    const scale = s / 128;

    // Background circle
    ctx.fillStyle = '#1c2240';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.fill();

    // Chain + magnifying glass
    ctx.strokeStyle = '#3ecfff';
    ctx.lineWidth = Math.max(1, 4 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Simplified chain links
    ctx.beginPath();
    ctx.arc(42 * scale, 64 * scale, 12 * scale, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(58 * scale, 64 * scale, 12 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Magnifying glass
    ctx.beginPath();
    ctx.arc(72 * scale, 50 * scale, 16 * scale, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = Math.max(1, 5 * scale);
    ctx.beginPath();
    ctx.moveTo(84 * scale, 62 * scale);
    ctx.lineTo(96 * scale, 76 * scale);
    ctx.stroke();

    return canvas.toBuffer('image/png');
}

// Check if canvas module is available
try {
    for (const size of sizes) {
        const buf = drawIcon(size);
        const outPath = path.join(__dirname, `icon${size}.png`);
        fs.writeFileSync(outPath, buf);
        console.log(`Created ${outPath}`);
    }
} catch (e) {
    console.log('canvas module not available. Please use generate-icons.html in browser instead.');
    console.log('Or run: npm install canvas && node generate-icons.js');
}
