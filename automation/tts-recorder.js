/**
 * KUX TTS — Kyutai TTS 1.6B Playwright Automation (Parallel Worker + Proxy Version)
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_RETRIES = 2;
const GENERATION_TIMEOUT_SEC = 150; 
const CONCURRENCY = 4; // 1 account par 4 tabs

async function fetchFreeProxies() {
    return new Promise((resolve) => {
        // Simple proxy list fetch from common public source for safety
        https.get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const list = data.trim().split('\n').map(p => `http://${p.trim()}`);
                resolve(list.length > 5 ? list : []);
            });
        }).on('error', () => resolve([]));
    });
}

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
    await page.waitForTimeout(2000);
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

async function processPart(browser, part, voice, downloadsDir, proxyList) {
    let success = false;
    const proxy = proxyList.length ? proxyList[Math.floor(Math.random() * proxyList.length)] : null;
    
    // Create NEW context per tab for better proxy isolation and clean state
    const context = await browser.newContext({
        proxy: proxy ? { server: proxy } : undefined,
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        acceptDownloads: true,
    });
    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

    const page = await context.newPage();
    console.log(`🎬 [Part ${part.id}] Started | Proxy: ${proxy || 'DIRECT'}`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) console.log(`   🔄 [Part ${part.id}] Retry #${attempt}...`);
        try {
            await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(4000);

            const section = await findTTS16BSection(page);
            
            // 1. Tick "Show all voices"
            if (section.checkbox) {
                const isChecked = await section.checkbox.isChecked();
                if (!isChecked) {
                    await section.checkbox.click();
                    await page.waitForTimeout(2000); // Give it time to load list
                }
            }

            // 2. Select Voice
            if (section.voiceSelect && voice) {
                try {
                    await section.voiceSelect.selectOption({ label: voice });
                    await page.waitForTimeout(500);
                } catch {
                    console.log(`   ⚠️ [Part ${part.id}] Voice [${voice}] not found in dropdown yet, waiting...`);
                    await page.waitForTimeout(2000);
                    await section.voiceSelect.selectOption({ label: voice }).catch(() => {});
                }
            }

            // 3. Fill Text
            await section.textarea.fill(part.text);

            // 4. Click Play
            const playButtons = await page.$$('button:has-text("Play")');
            const playBtn = playButtons[section.sectionIdx] || playButtons[0];
            if (!playBtn) throw new Error("Play button not found");
            await playBtn.click();

            // 5. Wait for Generation
            const startTime = Date.now();
            let audioGenerated = false;
            while (Date.now() - startTime < GENERATION_TIMEOUT_SEC * 1000) {
                const status = await page.evaluate(() => {
                    const texts = Array.from(document.querySelectorAll('*')).map(el => el.textContent).join(' ');
                    return { streaming: texts.includes('Streaming'), connected: texts.includes('Connected') };
                });
                if (status.streaming) audioGenerated = true;
                if (audioGenerated && !status.streaming) break;
                await page.waitForTimeout(3000);
            }

            // 6. Find Download Button (next to Play)
            const allBtns = await page.$$('button');
            let downloadBtn = null;
            let foundPlay = false;
            for (const btn of allBtns) {
                const text = await btn.textContent().catch(() => '');
                if (text.includes('Play')) { foundPlay = true; continue; }
                if (foundPlay) { downloadBtn = btn; break; }
            }

            if (downloadBtn) {
                const dlPromise = page.waitForEvent('download', { timeout: 30000 });
                await downloadBtn.click();
                const download = await dlPromise;
                const filePath = path.join(downloadsDir, `part_${part.id}.wav`);
                await download.saveAs(filePath);
                console.log(`   💾 [Part ${part.id}] Saved (${voice})`);
                success = true;
                break;
            } else throw new Error("Download button not found");

        } catch (err) {
            console.log(`   ❌ [Part ${part.id}] Error: ${err.message}`);
            if (attempt === MAX_RETRIES) break;
        }
    }

    await context.close();
    return success;
}

(async () => {
    const input = readInput();
    const { parts, voice = 'Show host (US, m)' } = input;
    const downloadsDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    // Fetch proxies
    console.log('🌐 Fetching fresh proxies...');
    const proxies = await fetchFreeProxies();
    console.log(`📡 Found ${proxies.length} potential proxies.`);

    const browser = await chromium.launch({ headless: true });
    
    let successCount = 0;
    let failCount = 0;
    const queue = [...parts];
    const workersCount = Math.min(queue.length, CONCURRENCY);

    console.log(`🚀 Processing ${parts.length} parts with ${workersCount} parallel tabs...`);

    const workers = Array(workersCount).fill(0).map(async () => {
        while (queue.length > 0) {
            const part = queue.shift();
            const ok = await processPart(browser, part, voice, downloadsDir, proxies);
            if (ok) successCount++; else failCount++;
        }
    });

    await Promise.all(workers);
    await browser.close();

    const savedFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.wav'));
    fs.writeFileSync(path.join(__dirname, 'tts-result.json'), JSON.stringify({
        totalParts: parts.length, success: successCount, failed: failCount, files: savedFiles, timestamp: new Date().toISOString()
    }, null, 2));

    process.exit(failCount > 0 ? 1 : 0);
})();
