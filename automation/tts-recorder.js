/**
 * KUX TTS — Kyutai TTS 1.6B Playwright Automation (Fixed & Robust)
 * 
 * Key fixes:
 * - No proxy (dead proxies were causing failures)
 * - Single browser context (saves memory on GitHub runner)
 * - Proper "Show all voices" checkbox handling
 * - Better download detection
 * - Screenshot on failure for debugging
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

async function processPart(page, part, voice, downloadsDir) {
    let success = false;

    console.log(`\n🎬 [Part ${part.id}] Starting (${part.text.length} chars) | Voice: ${voice}`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(`   🔄 [Part ${part.id}] Retry #${attempt}...`);
            await page.waitForTimeout(2000);
        }
        try {
            // 1. Navigate to TTS page
            console.log(`   📡 Navigating to Kyutai TTS...`);
            await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(5000); // Wait for page to fully render

            // 2. Dismiss any consent popups
            try {
                const consentBtn = page.locator('button:has-text("Accept"), button:has-text("OK"), button:has-text("Agree")');
                if (await consentBtn.count() > 0) {
                    await consentBtn.first().click();
                    await page.waitForTimeout(1000);
                }
            } catch { }

            // 3. Scroll down to find the 1.6B section
            console.log(`   🔍 Finding TTS 1.6B section...`);
            await page.evaluate(() => {
                const headers = document.querySelectorAll('h1, h2, h3, h4, h5, p, span');
                for (const h of headers) {
                    if (h.textContent && h.textContent.includes('1.6B')) {
                        h.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        return;
                    }
                }
                // Fallback: scroll to bottom half
                window.scrollTo(0, document.body.scrollHeight * 0.6);
            });
            await page.waitForTimeout(2000);

            // 4. Get all form elements
            const textareas = await page.$$('textarea');
            const selects = await page.$$('select');
            const checkboxes = await page.$$('input[type="checkbox"]');

            console.log(`   📋 Found: ${textareas.length} textareas, ${selects.length} selects, ${checkboxes.length} checkboxes`);

            // The 1.6B section is typically the second set of controls
            const sectionIdx = textareas.length >= 2 ? 1 : 0;
            const textarea = textareas[sectionIdx] || textareas[0];
            const voiceSelect = selects[sectionIdx] || selects[0];

            if (!textarea) throw new Error('Textarea not found!');

            // 5. Check "Show all voices" checkbox (the one in 1.6B section)
            // Try to find and check ALL checkboxes that could be "show all voices"
            for (let ci = 0; ci < checkboxes.length; ci++) {
                try {
                    const isChecked = await checkboxes[ci].isChecked();
                    if (!isChecked) {
                        console.log(`   ☑️  Checking checkbox #${ci}...`);
                        await checkboxes[ci].click();
                        await page.waitForTimeout(2000);
                    } else {
                        console.log(`   ✅ Checkbox #${ci} already checked`);
                    }
                } catch (e) {
                    console.log(`   ⚠️  Checkbox #${ci} error: ${e.message}`);
                }
            }

            // 6. Select voice
            if (voiceSelect && voice) {
                console.log(`   🎤 Selecting voice: ${voice}`);
                // First list all available options
                const options = await voiceSelect.$$eval('option', opts => opts.map(o => ({ value: o.value, label: o.textContent })));
                console.log(`   📊 Available voices: ${options.length}`);
                if (options.length <= 5) {
                    console.log(`   📋 Options: ${options.map(o => o.label).join(', ')}`);
                }

                try {
                    await voiceSelect.selectOption({ label: voice });
                    console.log(`   ✅ Voice selected: ${voice}`);
                } catch {
                    // Try by value
                    try {
                        await voiceSelect.selectOption(voice);
                        console.log(`   ✅ Voice selected by value`);
                    } catch {
                        console.log(`   ⚠️  Voice "${voice}" not found, using default`);
                    }
                }
                await page.waitForTimeout(500);
            }

            // 7. Fill text
            console.log(`   ✍️  Filling text (${part.text.length} chars)...`);
            await textarea.click();
            await textarea.fill('');
            await page.waitForTimeout(300);
            await textarea.fill(part.text);
            await page.waitForTimeout(500);

            // 8. Find and click Play button
            console.log(`   ▶️  Looking for Play button...`);
            const allButtons = await page.$$('button');
            let playBtn = null;
            let playBtnIdx = -1;

            for (let bi = 0; bi < allButtons.length; bi++) {
                const text = await allButtons[bi].textContent().catch(() => '');
                if (text.trim() === 'Play') {
                    playBtn = allButtons[bi];
                    playBtnIdx = bi;
                }
            }

            // Use the LAST Play button (likely the 1.6B one)
            if (!playBtn) throw new Error('Play button not found');
            console.log(`   ▶️  Clicking Play button #${playBtnIdx}...`);
            await playBtn.click();

            // 9. Wait for audio generation
            console.log(`   ⏳ Waiting for audio generation...`);
            const startTime = Date.now();
            let audioStarted = false;
            let audioDone = false;

            while (Date.now() - startTime < GENERATION_TIMEOUT_SEC * 1000) {
                const pageText = await page.evaluate(() => document.body.innerText);

                if (pageText.includes('Streaming') || pageText.includes('streaming')) {
                    if (!audioStarted) {
                        audioStarted = true;
                        console.log(`   🔊 Audio streaming started!`);
                    }
                }

                if (audioStarted && !pageText.includes('Streaming') && !pageText.includes('streaming')) {
                    audioDone = true;
                    console.log(`   ✅ Audio generation complete!`);
                    break;
                }

                // Check for "Not connected" or errors
                if (pageText.includes('Not connected')) {
                    console.log(`   ⚠️  Status: Not connected (waiting...)`);
                }

                await page.waitForTimeout(3000);
            }

            if (!audioDone && !audioStarted) {
                // Take debug screenshot
                const ssPath = path.join(downloadsDir, `debug_part${part.id}_attempt${attempt}.png`);
                await page.screenshot({ path: ssPath, fullPage: false });
                console.log(`   📸 Debug screenshot saved: ${ssPath}`);
                throw new Error('Audio generation did not start');
            }

            await page.waitForTimeout(2000); // Give it a moment to finalize

            // 10. Find download button
            console.log(`   💾 Looking for download button...`);
            
            // Method 1: Look for download/save buttons near the play button area
            const buttonsAfterPlay = await page.$$('button');
            let downloadBtn = null;

            // Look for any button with download-like SVG or aria-label
            for (const btn of buttonsAfterPlay) {
                const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
                const title = await btn.getAttribute('title').catch(() => '');
                const text = await btn.textContent().catch(() => '');
                
                if (ariaLabel?.toLowerCase().includes('download') || 
                    title?.toLowerCase().includes('download') ||
                    text?.toLowerCase().includes('download') ||
                    text?.toLowerCase().includes('save')) {
                    downloadBtn = btn;
                    break;
                }
            }

            // Method 2: Look for the button right after the last Play button
            if (!downloadBtn) {
                let foundPlay = false;
                for (const btn of buttonsAfterPlay) {
                    const text = await btn.textContent().catch(() => '');
                    if (text.trim() === 'Play') {
                        // Check if this is near our play button
                        const box = await btn.boundingBox().catch(() => null);
                        const playBox = await playBtn.boundingBox().catch(() => null);
                        if (box && playBox && Math.abs(box.y - playBox.y) < 50) {
                            foundPlay = true;
                            continue;
                        }
                    }
                    if (foundPlay) {
                        downloadBtn = btn;
                        break;
                    }
                }
            }

            // Method 3: Look for <a> download links
            if (!downloadBtn) {
                const downloadLinks = await page.$$('a[download], a[href*="blob:"]');
                if (downloadLinks.length > 0) {
                    downloadBtn = downloadLinks[downloadLinks.length - 1];
                    console.log(`   ℹ️  Found download link`);
                }
            }

            if (downloadBtn) {
                console.log(`   💾 Clicking download...`);
                const dlPromise = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
                await downloadBtn.click();
                const download = await dlPromise;

                if (download) {
                    const filePath = path.join(downloadsDir, `part_${part.id}.wav`);
                    await download.saveAs(filePath);
                    const stats = fs.statSync(filePath);
                    const sizeKB = (stats.size / 1024).toFixed(1);
                    console.log(`   🎉 [Part ${part.id}] SAVED! (${sizeKB} KB)`);
                    success = true;
                    break;
                } else {
                    console.log(`   ⚠️  Download event not triggered`);
                    // Try to extract audio from page directly
                    const audioSrcs = await page.$$eval('audio', els => els.map(a => a.src).filter(s => s));
                    if (audioSrcs.length > 0) {
                        console.log(`   🔊 Found ${audioSrcs.length} audio elements, trying to save...`);
                        const lastSrc = audioSrcs[audioSrcs.length - 1];
                        if (lastSrc.startsWith('blob:')) {
                            // Can't directly download blob URLs, try via fetch
                            const audioData = await page.evaluate(async (src) => {
                                const resp = await fetch(src);
                                const blob = await resp.blob();
                                const reader = new FileReader();
                                return new Promise(resolve => {
                                    reader.onloadend = () => resolve(reader.result);
                                    reader.readAsDataURL(blob);
                                });
                            }, lastSrc);
                            
                            if (audioData) {
                                const base64 = audioData.split(',')[1];
                                const buf = Buffer.from(base64, 'base64');
                                const filePath = path.join(downloadsDir, `part_${part.id}.wav`);
                                fs.writeFileSync(filePath, buf);
                                const sizeKB = (buf.length / 1024).toFixed(1);
                                console.log(`   🎉 [Part ${part.id}] SAVED via blob! (${sizeKB} KB)`);
                                success = true;
                                break;
                            }
                        }
                    }
                }
            } else {
                // Last resort: try to get audio from <audio> elements
                console.log(`   ⚠️  No download button found, trying audio elements...`);
                const audioSrcs = await page.$$eval('audio', els => els.map(a => a.src).filter(s => s));
                console.log(`   🔊 Audio elements found: ${audioSrcs.length}`);
                
                if (audioSrcs.length > 0) {
                    const lastSrc = audioSrcs[audioSrcs.length - 1];
                    console.log(`   🔊 Audio src: ${lastSrc.substring(0, 50)}...`);
                    
                    if (lastSrc.startsWith('blob:')) {
                        const audioData = await page.evaluate(async (src) => {
                            const resp = await fetch(src);
                            const blob = await resp.blob();
                            const reader = new FileReader();
                            return new Promise(resolve => {
                                reader.onloadend = () => resolve(reader.result);
                                reader.readAsDataURL(blob);
                            });
                        }, lastSrc);
                        
                        if (audioData) {
                            const base64 = audioData.split(',')[1];
                            const buf = Buffer.from(base64, 'base64');
                            const filePath = path.join(downloadsDir, `part_${part.id}.wav`);
                            fs.writeFileSync(filePath, buf);
                            const sizeKB = (buf.length / 1024).toFixed(1);
                            console.log(`   🎉 [Part ${part.id}] SAVED via audio element! (${sizeKB} KB)`);
                            success = true;
                            break;
                        }
                    }
                }

                // Debug screenshot
                const ssPath = path.join(downloadsDir, `debug_part${part.id}_no_dl_attempt${attempt}.png`);
                await page.screenshot({ path: ssPath, fullPage: false });
                console.log(`   📸 Debug screenshot: ${ssPath}`);
                throw new Error('Download button not found');
            }

        } catch (err) {
            console.log(`   ❌ [Part ${part.id}] Error: ${err.message}`);
        }
    }

    if (!success) {
        console.log(`   ❌ [Part ${part.id}] FAILED after ${MAX_RETRIES + 1} attempts`);
    }

    return success;
}

(async () => {
    const input = readInput();
    const { parts, voice = 'Show host (US, m)' } = input;

    if (!parts || parts.length === 0) {
        console.error('❌ No parts provided');
        process.exit(1);
    }

    const downloadsDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    console.log(`🚀 KUX TTS Automation Starting`);
    console.log(`   Parts: ${parts.length} | Voice: ${voice}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-web-security',
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        acceptDownloads: true,
    });

    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

    // Process parts SEQUENTIALLY (more reliable on GitHub runner with limited resources)
    const page = await context.newPage();
    let successCount = 0;
    let failCount = 0;

    for (const part of parts) {
        const ok = await processPart(page, part, voice, downloadsDir);
        if (ok) successCount++;
        else failCount++;
    }

    await browser.close();

    const savedFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.wav'));

    const resultFile = path.join(__dirname, 'tts-result.json');
    fs.writeFileSync(resultFile, JSON.stringify({
        totalParts: parts.length,
        success: successCount,
        failed: failCount,
        files: savedFiles,
        debugFiles: fs.readdirSync(downloadsDir).filter(f => f.endsWith('.png')),
        timestamp: new Date().toISOString(),
    }, null, 2));

    console.log(`\n📊 Results: ${successCount}/${parts.length} succeeded, ${failCount} failed`);
    console.log(`📁 Files: ${savedFiles.join(', ') || 'none'}`);

    process.exit(failCount > 0 ? 1 : 0);
})();
