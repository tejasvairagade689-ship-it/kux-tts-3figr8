/**
 * KUX TTS — Kyutai TTS 1.6B Playwright Automation
 * Simple & Reliable: 1 Browser Tab per GitHub Runner
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_RETRIES = 3;
const GENERATION_TIMEOUT_SEC = 180;

function readInput() {
    const inputFile = path.join(__dirname, 'tts-input.json');
    if (!fs.existsSync(inputFile)) {
        console.error('❌ automation/tts-input.json not found!');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
}

async function setupPage(page) {
    console.log('🌐 Loading Kyutai TTS...');
    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // Dismiss consent
    try {
        const btn = page.locator('button:has-text("Accept"), button:has-text("OK")');
        if (await btn.count() > 0) { 
            await btn.first().click(); 
            await page.waitForTimeout(1000); 
        }
    } catch {}

    // Scroll to 1.6B
    await page.evaluate(() => {
        const headers = document.querySelectorAll('h1, h2, h3, h4, h5, p, span');
        for (const h of headers) {
            if (h.textContent && h.textContent.includes('1.6B')) {
                h.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
        }
    });
    await page.waitForTimeout(2000);

    // Get elements
    const textareas = await page.$$('textarea');
    const selects = await page.$$('select');
    const checkboxes = await page.$$('input[type="checkbox"]');
    
    // Usually 1.6B is the second textarea if 7B is present, otherwise first
    const sectionIdx = textareas.length >= 2 ? 1 : 0;

    // "Show all voices" checkbox
    for (const cb of checkboxes) {
        try {
            if (!(await cb.isChecked())) { 
                await cb.click(); 
                await page.waitForTimeout(2000); 
            }
        } catch {}
    }

    return {
        textarea: textareas[sectionIdx] || textareas[0],
        voiceSelect: selects[sectionIdx] || selects[0]
    };
}

async function generateAudio(page, part, voice, downloadsDir) {
    console.log(`🎬 [Part ${part.id}] ${part.text.substring(0, 30)}...`);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const ui = await setupPage(page);
            if (!ui.textarea) throw new Error('Textarea not found');

            // Select voice
            if (ui.voiceSelect && voice) {
                console.log(`   🎤 Selecting voice: ${voice}`);
                await ui.voiceSelect.selectOption({ label: voice }).catch(async () => {
                    await ui.voiceSelect.selectOption(voice);
                });
                await page.waitForTimeout(1000);
            }

            // Fill text
            await ui.textarea.fill(part.text);
            await page.waitForTimeout(1000);

            // Play button
            const allBtns = await page.$$('button');
            let playBtn = null;
            for (const btn of allBtns) {
                const text = await btn.textContent();
                if (text && text.trim() === 'Play') {
                    playBtn = btn;
                    break;
                }
            }
            if (!playBtn) throw new Error('Play button not found');

            // Wait for connection
            let connected = false;
            for (let i = 0; i < 30; i++) {
                const t = await page.evaluate(() => document.body.innerText);
                if (!t.includes('Disconnected') && !t.includes('Not connected')) {
                    connected = true;
                    break;
                }
                await page.waitForTimeout(1000);
            }
            if (!connected) throw new Error('Kyutai server not connected');

            await playBtn.click();

            // Wait for "Streaming" or Done
            const start = Date.now();
            let streamingStarted = false;
            while (Date.now() - start < GENERATION_TIMEOUT_SEC * 1000) {
                const t = await page.evaluate(() => document.body.innerText);
                if (t.includes('Disconnected')) throw new Error('Connection lost');
                
                if (t.includes('Streaming')) {
                    if (!streamingStarted) {
                        streamingStarted = true;
                        console.log(`   🔊 Streaming started...`);
                    }
                } else if (streamingStarted) {
                    console.log(`   ✅ Generation complete.`);
                    break;
                }
                await page.waitForTimeout(2000);
            }

            if (!streamingStarted) throw new Error('Generation timed out');
            await page.waitForTimeout(3000);

            // Download
            const btns = await page.$$('button');
            let downloadBtn = null;
            let foundPlay = false;
            for (const btn of btns) {
                const text = await btn.textContent();
                if (text && text.trim() === 'Play') { foundPlay = true; continue; }
                if (foundPlay) { downloadBtn = btn; break; }
            }

            if (downloadBtn) {
                const [download] = await Promise.all([
                    page.waitForEvent('download', { timeout: 30000 }),
                    downloadBtn.click()
                ]);
                const filePath = path.join(downloadsDir, `part_${part.id}.wav`);
                await download.saveAs(filePath);
                console.log(`   💾 Saved to: part_${part.id}.wav`);
                return true;
            }

            // Fallback: Blob URL extraction
            const audioSrc = await page.$eval('audio', el => el.src).catch(() => null);
            if (audioSrc && audioSrc.startsWith('blob:')) {
                const data = await page.evaluate(async (src) => {
                    const r = await fetch(src);
                    const b = await r.blob();
                    return new Promise(res => {
                        const reader = new FileReader();
                        reader.onloadend = () => res(reader.result);
                        reader.readAsDataURL(b);
                    });
                }, audioSrc);
                const buffer = Buffer.from(data.split(',')[1], 'base64');
                fs.writeFileSync(path.join(downloadsDir, `part_${part.id}.wav`), buffer);
                console.log(`   💾 Saved via blob: part_${part.id}.wav`);
                return true;
            }

            throw new Error('Download button/audio src not found');

        } catch (err) {
            console.error(`   ❌ Attempt ${attempt} failed: ${err.message}`);
            if (attempt === MAX_RETRIES) {
                await page.screenshot({ path: path.join(downloadsDir, `error_p${part.id}.png`) });
            }
            await page.waitForTimeout(5000);
        }
    }
    return false;
}

(async () => {
    const input = readInput();
    const { parts, voice = 'Show host (US, m)' } = input;
    
    const downloadsDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    console.log(`🚀 KUX TTS | ${parts.length} parts | Single Tab Logic | Voice: ${voice}`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    let successCount = 0;
    let failedCount = 0;

    for (const part of parts) {
        const ok = await generateAudio(page, part, voice, downloadsDir);
        if (ok) successCount++;
        else failedCount++;
    }

    await browser.close();

    const result = {
        totalParts: parts.length,
        success: successCount,
        failed: failedCount,
        files: fs.readdirSync(downloadsDir).filter(f => f.endsWith('.wav')),
        timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(__dirname, 'tts-result.json'), JSON.stringify(result, null, 2));

    console.log(`\n📊 SUMMARY: ${successCount} successful, ${failedCount} failed.`);
    process.exit(failedCount > 0 ? 1 : 0);
})();
