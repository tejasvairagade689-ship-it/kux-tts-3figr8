/**
 * KUX TTS — Kyutai TTS 1.6B Playwright Automation
 * Dynamic Matrix Strategy: Single Job per Runner
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_RETRIES = 3;
const GENERATION_TIMEOUT_SEC = 240; // Increased for larger chunks
const CHUNK_SIZE = 500;

function getChunkInfo() {
    const chunkId = parseInt(process.env.CHUNK_ID || '0', 10);
    const inputFile = path.join(__dirname, '..', 'input.txt');
    
    if (!fs.existsSync(inputFile)) {
        console.error('❌ input.txt not found!');
        process.exit(1);
    }
    
    const fullText = fs.readFileSync(inputFile, 'utf-8');
    const start = chunkId * CHUNK_SIZE;
    const end = start + CHUNK_SIZE;
    const textChunk = fullText.substring(start, end).trim();
    
    return { id: chunkId, text: textChunk };
}

async function setupPage(page) {
    console.log('🌐 Loading Kyutai TTS...');
    await page.goto(TTS_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(5000);

    // Dismiss consent
    try {
        const btn = page.locator('button:has-text("Accept"), button:has-text("OK"), button:has-text("I agree")');
        if (await btn.count() > 0) { 
            await btn.first().click(); 
            await page.waitForTimeout(1000); 
        }
    } catch {}

    // Scroll to 1.6B section
    await page.evaluate(() => {
        const elements = document.querySelectorAll('h1, h2, h3, h4, x-gradio-component');
        for (const el of elements) {
            if (el.textContent && el.textContent.includes('1.6B')) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
        }
    });
    await page.waitForTimeout(2000);

    // Get elements using more robust selectors
    const textareas = await page.$$('textarea');
    const selects = await page.$$('select');
    const checkboxes = await page.$$('input[type="checkbox"]');
    
    // Kyutai usually has 7B first, then 1.6B
    const sectionIdx = textareas.length >= 2 ? 1 : 0;

    // "Show all voices" checkbox - usually the first or second
    for (const cb of checkboxes) {
        try {
            const label = await page.evaluate(el => el.parentElement?.innerText, cb);
            if (label && label.includes('Show')) {
                if (!(await cb.isChecked())) { 
                    await cb.click(); 
                    await page.waitForTimeout(2000); 
                }
            }
        } catch {}
    }

    return {
        textarea: textareas[sectionIdx] || textareas[0],
        voiceSelect: selects[sectionIdx] || selects[0]
    };
}

async function generateAudio(page, part, voice, downloadsDir) {
    console.log(`🎬 [Job ${part.id}] Processing chunk (${part.text.length} chars)`);
    if (!part.text) {
        console.warn(`⚠️ [Job ${part.id}] Text is empty, skipping.`);
        return true; 
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const ui = await setupPage(page);
            if (!ui.textarea) throw new Error('Textarea for 1.6B not found');

            // Select voice
            if (ui.voiceSelect && voice) {
                console.log(`   🎤 Selecting voice: ${voice}`);
                await ui.voiceSelect.selectOption({ label: voice }).catch(async () => {
                    await ui.voiceSelect.selectOption(voice);
                });
                await page.waitForTimeout(1000);
            }

            // Fill text with interaction
            await ui.textarea.click();
            await ui.textarea.fill(part.text);
            await page.waitForTimeout(1000);

            // Find Play button - search specifically within the 1.6B context if possible
            const allBtns = await page.$$('button');
            let playBtn = null;
            for (const btn of allBtns) {
                const text = await btn.textContent();
                // Match "Play" exactly to avoid clicking "Stop" or "Download"
                if (text && text.trim() === 'Play') {
                    // Check if it's in the 1.6B section (after our textarea)
                    const box = await btn.boundingBox();
                    const areaBox = await ui.textarea.boundingBox();
                    if (box && areaBox && box.y > areaBox.y) {
                        playBtn = btn;
                        break;
                    }
                }
            }
            if (!playBtn) throw new Error('Play button not found');

            // Wait for connection - with reload fallback
            let connected = false;
            for (let i = 0; i < 30; i++) {
                const t = await page.evaluate(() => document.body.innerText);
                if (!t.includes('Disconnected') && !t.includes('Not connected')) {
                    connected = true;
                    break;
                }
                // Try clicking Play anyway later to force connection
                if (i === 15) {
                    console.log('   🔄 Still not connected, reloading once...');
                    await page.reload({ waitUntil: 'networkidle' });
                    return await generateAudio(page, part, voice, downloadsDir); // Recursive retry
                }
                await page.waitForTimeout(1000);
            }

            console.log(`   ▶️ Clicking Play...`);
            await playBtn.click();

            // Wait for "Streaming" or Completion
            const start = Date.now();
            let streamingStarted = false;
            let success = false;
            
            while (Date.now() - start < GENERATION_TIMEOUT_SEC * 1000) {
                const t = await page.evaluate(() => document.body.innerText);
                
                if (t.includes('Disconnected')) throw new Error('Connection lost during generation');
                
                if (t.includes('Streaming')) {
                    if (!streamingStarted) {
                        streamingStarted = true;
                        console.log(`   🔊 Streaming started...`);
                    }
                } else {
                    // If we were streaming and it stopped, it's likely done
                    // Or if we see the audio element has a duration
                    const hasAudio = await page.evaluate(() => {
                        const audios = document.querySelectorAll('audio');
                        for (const a of audios) {
                            if (a.duration > 0 && !a.paused) return true;
                            if (a.src && a.src.startsWith('blob:') && a.duration > 0) return true;
                        }
                        return false;
                    });
                    
                    if (streamingStarted || hasAudio) {
                        console.log(`   ✅ Generation complete.`);
                        success = true;
                        break;
                    }
                }
                await page.waitForTimeout(3000);
            }

            if (!success) throw new Error('Generation timed out or failed to start');
            await page.waitForTimeout(5000); // Wait for final buffer

            // Robust Download Handling
            console.log(`   📥 Attempting download...`);
            
            // Try to find the download button near the Play button
            const btns = await page.$$('button');
            let downloadBtn = null;
            let foundPlay = false;
            for (const btn of btns) {
                const text = await btn.textContent();
                if (text && text.trim() === 'Play') { foundPlay = true; continue; }
                // Usually the button after Play is Download or has a download icon
                if (foundPlay) {
                    const isVisible = await btn.isVisible();
                    if (isVisible) {
                        downloadBtn = btn; 
                        break; 
                    }
                }
            }

            if (downloadBtn) {
                try {
                    const [download] = await Promise.all([
                        page.waitForEvent('download', { timeout: 45000 }),
                        downloadBtn.click()
                    ]);
                    const filePath = path.join(downloadsDir, `chunk_${part.id}.wav`);
                    await download.saveAs(filePath);
                    console.log(`   💾 Saved: chunk_${part.id}.wav`);
                    return true;
                } catch (e) {
                    console.warn(`   ⚠️ Download button click failed: ${e.message}, trying fallback...`);
                }
            }

            // Fallback: Direct Blob Extraction
            console.log(`   🧩 Fallback: Extracting audio blob...`);
            const audioSrc = await page.evaluate(() => {
                const audios = document.querySelectorAll('audio');
                // Pick the one with a blob src and duration
                for (const a of audios) {
                    if (a.src && a.src.startsWith('blob:') && a.duration > 0) return a.src;
                }
                return audios[0]?.src || null;
            });

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
                fs.writeFileSync(path.join(downloadsDir, `chunk_${part.id}.wav`), buffer);
                console.log(`   💾 Saved via blob: chunk_${part.id}.wav`);
                return true;
            }

            throw new Error('Could not capture audio output');

        } catch (err) {
            console.error(`   ❌ Attempt ${attempt} failed: ${err.message}`);
            if (attempt === MAX_RETRIES) {
                await page.screenshot({ path: path.join(downloadsDir, `error_job${part.id}.png`), fullPage: true });
            }
            await page.waitForTimeout(5000);
        }
    }
    return false;
}

(async () => {
    const part = getChunkInfo();
    const voice = process.env.VOICE_NAME || 'Show host (US, m)';
    
    const downloadsDir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

    console.log(`🚀 KUX WORKER | Job ID: ${part.id} | Voice: ${voice}`);

    const browser = await chromium.launch({ 
        headless: true,
        args: [
            '--disable-dev-shm-usage', 
            '--no-sandbox',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ] 
    });
    
    const context = await browser.newContext({ 
        acceptDownloads: true,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();

    // Jugaad 2: API Interception Logic
    // Detects the /tts request and forces the target voice ID in the multipart form data
    await page.route('**/tts', async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
            let postData = request.postData();
            if (postData && postData.includes('name="voice_url"')) {
                try {
                    console.log(`   🛠️ [Jugaad 2] Intercepting request to: ${request.url()}`);
                    
                    // Find boundary to parse multipart accurately
                    const boundaryMatch = postData.match(/^--[^\r\n]+/);
                    if (boundaryMatch) {
                        const boundary = boundaryMatch[0];
                        const parts = postData.split(boundary);
                        
                        const modifiedParts = parts.map(p => {
                            if (p.includes('name="voice_url"')) {
                                // Multipart parts usually look like:
                                // \r\nContent-Disposition: form-data; name="voice_url"\r\n\r\n[VALUE]\r\n
                                const subParts = p.split('\r\n\r\n');
                                if (subParts.length >= 2) {
                                    // subParts[1] contains the value and the trailing \r\n
                                    // We replace the value but keep a trailing \r\n if it was there
                                    subParts[1] = voice + (subParts[1].endsWith('\r\n') ? '\r\n' : '');
                                    return subParts.join('\r\n\r\n');
                                }
                            }
                            return p;
                        });
                        
                        const modifiedData = modifiedParts.join(boundary);
                        console.log(`   ✅ [Jugaad 2] INTERCEPT SUCCESS! Forced voice: ${voice}`);
                        await route.continue({ postData: modifiedData });
                        return;
                    }
                } catch (err) {
                    console.error(`   ⚠️ [Jugaad 2] Interception failed: ${err.message}`);
                }
            }
        }
        await route.continue();
    });

    const ok = await generateAudio(page, part, voice, downloadsDir);

    await browser.close();

    const result = {
        jobId: part.id,
        success: ok,
        file: ok ? `chunk_${part.id}.wav` : null,
        timestamp: new Date().toISOString()
    };
    
    fs.writeFileSync(path.join(__dirname, `result_job${part.id}.json`), JSON.stringify(result, null, 2));

    console.log(`\n🏁 JOB ${part.id} ${ok ? 'PASSED' : 'FAILED'}`);
    process.exit(ok ? 0 : 1);
})();
