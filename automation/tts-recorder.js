/**
 * KUX TTS — Kyutai TTS 1.6B Playwright Automation (Parallel Worker Version)
 * 
 * Auto-chunks and generates audio using multiple tabs.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_RETRIES = 2;
const GENERATION_TIMEOUT_SEC = 120;
const CONCURRENCY = 5;

function readInput() {
    const inputFile = path.join(__dirname, 'tts-input.json');
    if (!fs.existsSync(inputFile)) {
        console.error('❌ automation/tts-input.json not found!');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
}

async function findTTS16BSection(page) {
    await page.evaluate(() => {
        const headers = document.querySelectorAll('h2, h3, h4');
        for (const h of headers) {
            if (h.textContent.includes('1.6B')) {
                h.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return true;
            }
        }
        window.scrollTo(0, document.body.scrollHeight / 2);
        return false;
    });

    await page.waitForTimeout(1500);

    const textareas = await page.$$('textarea[placeholder="Enter text..."]');
    const selects = await page.$$('select');
    const checkboxes = await page.$$('input[type="checkbox"]');

    const sectionIdx = textareas.length >= 2 ? 1 : 0;

    return {
        textarea: textareas[sectionIdx] || textareas[0],
        voiceSelect: selects[sectionIdx] || selects[0],
        checkbox: checkboxes[sectionIdx] || checkboxes[0],
        sectionIdx,
    };
}

async function processPart(context, part, voice, downloadsDir) {
    const page = await context.newPage();
    let success = false;

    console.log(`🎬 [Part ${part.id}] Started (${part.text.length} chars)`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(`   🔄 [Part ${part.id}] Retry #${attempt}...`);
        }
        try {
            await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(3000);

            try {
                const consentBtn = page.locator('button:has-text("Accept"), button:has-text("OK"), button:has-text("Agree")');
                if (await consentBtn.count() > 0) {
                    await consentBtn.first().click();
                    await page.waitForTimeout(1000);
                }
            } catch { }

            const section = await findTTS16BSection(page);

            if (section.checkbox) {
                const isChecked = await section.checkbox.isChecked();
                if (!isChecked) {
                    await section.checkbox.click();
                    await page.waitForTimeout(1000);
                }
            }

            if (section.voiceSelect && voice) {
                try {
                    await section.voiceSelect.selectOption({ label: voice });
                } catch {
                    console.log(`   ⚠️ [Part ${part.id}] Voice error, using default`);
                }
            }

            await section.textarea.click();
            await page.keyboard.press('Control+A');
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);
            await section.textarea.fill(part.text);

            const playButtons = await page.$$('button:has-text("Play")');
            const playBtn = playButtons[section.sectionIdx] || playButtons[0];

            if (!playBtn) {
                throw new Error("Play button not found");
            }

            await playBtn.click();

            const startTime = Date.now();
            let audioGenerated = false;

            while (Date.now() - startTime < GENERATION_TIMEOUT_SEC * 1000) {
                const statusTexts = await page.$$eval('*', (elements) => {
                    return elements
                        .filter(el => el.textContent && (el.textContent.includes('Streaming') || el.textContent.includes('Connected')))
                        .map(el => el.textContent.trim().substring(0, 50));
                });

                if (statusTexts.some(t => t.includes('Streaming'))) {
                    if (!audioGenerated) audioGenerated = true;
                }

                if (audioGenerated) {
                    const stillStreaming = statusTexts.some(t => t.includes('Streaming'));
                    if (!stillStreaming) {
                        break;
                    }
                }
                await page.waitForTimeout(2000);
            }

            const allBtns = await page.$$('button');
            let downloadBtn = null;
            let foundPlay = false;

            for (const btn of allBtns) {
                const text = await btn.textContent().catch(() => '');
                if (text.includes('Play')) {
                    const box = await btn.boundingBox();
                    const playBox = await playBtn.boundingBox();
                    if (box && playBox && Math.abs(box.y - playBox.y) < 10) {
                        foundPlay = true;
                        continue;
                    }
                }
                if (foundPlay) {
                    downloadBtn = btn;
                    break;
                }
            }

            if (downloadBtn) {
                const dl = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
                await downloadBtn.click();
                const download = await dl;

                if (download) {
                    const filePath = path.join(downloadsDir, `part_${part.id}.wav`);
                    await download.saveAs(filePath);
                    const stats = fs.statSync(filePath);
                    const sizeKB = (stats.size / 1024).toFixed(1);
                    console.log(`   💾 [Part ${part.id}] Saved (${sizeKB} KB)`);
                    success = true;
                    break;
                } else {
                    throw new Error("Download event didn't trigger");
                }
            } else {
                throw new Error("Download button not found");
            }
        } catch (err) {
            console.log(`   ❌ [Part ${part.id}] Error: ${err.message}`);
        }
    }

    if (!success) {
        console.log(`   ❌ [Part ${part.id}] FAILED`);
    }

    await page.close();
    return success;
}

(async () => {
    const input = readInput();
    const { parts, voice = 'Show host (US, m)', proxy } = input;

    if (!parts || parts.length === 0) {
        console.error('❌ No parts provided');
        process.exit(1);
    }

    const downloadsDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const launchOpts = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
        ]
    };
    if (proxy) {
        launchOpts.proxy = { server: proxy };
    }

    const browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        acceptDownloads: true,
    });

    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

    let successCount = 0;
    let failCount = 0;

    const queue = [...parts];
    const workersCount = Math.min(queue.length, CONCURRENCY);

    console.log(`🚀 Starting ${workersCount} parallel tabs to process ${parts.length} parts...`);

    const workers = Array(workersCount).fill(0).map(async () => {
        while (queue.length > 0) {
            const part = queue.shift();
            const ok = await processPart(context, part, voice, downloadsDir);
            if (ok) successCount++;
            else failCount++;
        }
    });

    await Promise.all(workers);

    await browser.close();

    const savedFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.wav'));

    const resultFile = path.join(__dirname, 'tts-result.json');
    fs.writeFileSync(resultFile, JSON.stringify({
        totalParts: parts.length,
        success: successCount,
        failed: failCount,
        files: savedFiles,
        timestamp: new Date().toISOString(),
    }, null, 2));

    process.exit(failCount > 0 ? 1 : 0);
})();
