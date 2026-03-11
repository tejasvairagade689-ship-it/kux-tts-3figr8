/**
 * KUX TTS — Kyutai TTS 1.6B Playwright Automation
 * 4-5 Parallel Tabs per GitHub Runner for Maximum Speed
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_RETRIES = 2;
const GENERATION_TIMEOUT_SEC = 180;
const CONCURRENCY = 4; // 4 parallel tabs per runner

function readInput() {
    const inputFile = path.join(__dirname, 'tts-input.json');
    if (!fs.existsSync(inputFile)) {
        console.error('❌ automation/tts-input.json not found!');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
}

async function setupPage(page) {
    await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    // Dismiss consent
    try {
        const btn = page.locator('button:has-text("Accept"), button:has-text("OK")');
        if (await btn.count() > 0) { await btn.first().click(); await page.waitForTimeout(1000); }
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
        window.scrollTo(0, document.body.scrollHeight * 0.6);
    });
    await page.waitForTimeout(2000);

    // Get elements
    const textareas = await page.$$('textarea');
    const selects = await page.$$('select');
    const checkboxes = await page.$$('input[type="checkbox"]');
    const sectionIdx = textareas.length >= 2 ? 1 : 0;

    // Check all checkboxes (Show all voices)
    for (const cb of checkboxes) {
        try {
            if (!(await cb.isChecked())) { await cb.click(); await page.waitForTimeout(1500); }
        } catch {}
    }

    return {
        textarea: textareas[sectionIdx] || textareas[0],
        voiceSelect: selects[sectionIdx] || selects[0],
        sectionIdx
    };
}

async function processPart(page, part, voice, downloadsDir) {
    console.log(`🎬 [Part ${part.id}] Starting (${part.text.length} chars)`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(`   🔄 [Part ${part.id}] Retry #${attempt}`);
            await page.waitForTimeout(2000);
        }
        try {
            const section = await setupPage(page);
            if (!section.textarea) throw new Error('Textarea not found');

            // Select voice
            if (section.voiceSelect && voice) {
                try { await section.voiceSelect.selectOption({ label: voice }); }
                catch { try { await section.voiceSelect.selectOption(voice); } catch {} }
                await page.waitForTimeout(500);
            }

            // Fill text
            await section.textarea.fill(part.text);
            await page.waitForTimeout(500);

            // Click Play
            const allBtns = await page.$$('button');
            let playBtn = null;
            for (const btn of allBtns) {
                const text = await btn.textContent().catch(() => '');
                if (text.trim() === 'Play') playBtn = btn;
            }
            if (!playBtn) throw new Error('Play button not found');

            // Wait until connected (prevent clicking when "Disconnected" or "Not connected")
            let isConnected = false;
            for (let c = 0; c < 20; c++) {
                const pt = await page.evaluate(() => document.body.innerText);
                if (!pt.includes('Disconnected') && !pt.includes('Not connected')) {
                    isConnected = true; break;
                }
                await page.waitForTimeout(1000);
            }
            if (!isConnected) throw new Error('WebSocket Disconnected or Not connected after 20s');

            await playBtn.click();

            // Wait for generation
            const startTime = Date.now();
            let audioStarted = false;
            while (Date.now() - startTime < GENERATION_TIMEOUT_SEC * 1000) {
                const pageText = await page.evaluate(() => document.body.innerText);
                
                // If disconnected while waiting, fail fast instead of waiting 3 minutes
                if (pageText.includes('Disconnected') || pageText.includes('Not connected')) {
                    throw new Error('Connection lost during generation');
                }

                if (pageText.includes('Streaming')) { if (!audioStarted) { audioStarted = true; console.log(`   🔊 [Part ${part.id}] Streaming...`); } }
                if (audioStarted && !pageText.includes('Streaming')) { console.log(`   ✅ [Part ${part.id}] Done!`); break; }
                await page.waitForTimeout(3000);
            }

            if (!audioStarted) {
                const ss = path.join(downloadsDir, `debug_p${part.id}_a${attempt}.png`);
                await page.screenshot({ path: ss }); throw new Error('Audio did not start');
            }
            await page.waitForTimeout(2000);

            // Try download button
            const btns2 = await page.$$('button');
            let downloadBtn = null, foundPlay = false;
            for (const btn of btns2) {
                const text = await btn.textContent().catch(() => '');
                if (text.trim() === 'Play') { foundPlay = true; continue; }
                if (foundPlay) { downloadBtn = btn; break; }
            }

            if (downloadBtn) {
                const dlP = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
                await downloadBtn.click();
                const download = await dlP;
                if (download) {
                    const fp = path.join(downloadsDir, `part_${part.id}.wav`);
                    await download.saveAs(fp);
                    console.log(`   💾 [Part ${part.id}] Saved!`);
                    return true;
                }
            }

            // Fallback: extract from audio element blob
            const audioSrcs = await page.$$eval('audio', els => els.map(a => a.src).filter(s => s));
            if (audioSrcs.length > 0) {
                const lastSrc = audioSrcs[audioSrcs.length - 1];
                if (lastSrc.startsWith('blob:')) {
                    const audioData = await page.evaluate(async (src) => {
                        const r = await fetch(src); const b = await r.blob(); const rd = new FileReader();
                        return new Promise(res => { rd.onloadend = () => res(rd.result); rd.readAsDataURL(b); });
                    }, lastSrc);
                    if (audioData) {
                        const b64 = audioData.split(',')[1];
                        const buf = Buffer.from(b64, 'base64');
                        fs.writeFileSync(path.join(downloadsDir, `part_${part.id}.wav`), buf);
                        console.log(`   💾 [Part ${part.id}] Saved via blob!`);
                        return true;
                    }
                }
            }
            throw new Error('Download failed');
        } catch (err) {
            console.log(`   ❌ [Part ${part.id}] Error: ${err.message}`);
        }
    }
    console.log(`   ❌ [Part ${part.id}] FAILED`);
    return false;
}

(async () => {
    const input = readInput();
    const { parts, voice = 'Show host (US, m)' } = input;
    if (!parts || !parts.length) { console.error('❌ No parts'); process.exit(1); }

    const downloadsDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    console.log(`🚀 KUX TTS | ${parts.length} parts | ${CONCURRENCY} parallel tabs | Voice: ${voice}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        acceptDownloads: true,
    });
    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

    let successCount = 0, failCount = 0;
    const queue = [...parts];
    const tabCount = Math.min(queue.length, CONCURRENCY);

    console.log(`🔥 Launching ${tabCount} parallel tabs...`);

    // Create pages upfront
    const pages = [];
    for (let i = 0; i < tabCount; i++) {
        pages.push(await context.newPage());
    }

    // Worker function - each tab processes from the queue
    const workers = pages.map((page, idx) => (async () => {
        // Stagger the launch by 8 seconds per tab (important to prevent IP blocking/WebSocket throttling)
        await new Promise(r => setTimeout(r, idx * 8000));
        
        while (queue.length > 0) {
            const part = queue.shift();
            if (!part) break;
            console.log(`   🔧 Tab ${idx + 1} → Part ${part.id}`);
            const ok = await processPart(page, part, voice, downloadsDir);
            if (ok) successCount++; else failCount++;
        }
    })());

    await Promise.all(workers);
    await browser.close();

    const savedFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.wav'));
    fs.writeFileSync(path.join(__dirname, 'tts-result.json'), JSON.stringify({
        totalParts: parts.length, success: successCount, failed: failCount,
        files: savedFiles, debugFiles: fs.readdirSync(downloadsDir).filter(f => f.endsWith('.png')),
        timestamp: new Date().toISOString()
    }, null, 2));

    console.log(`\n📊 ${successCount}/${parts.length} succeeded | ${failCount} failed`);
    process.exit(failCount > 0 ? 1 : 0);
})();
