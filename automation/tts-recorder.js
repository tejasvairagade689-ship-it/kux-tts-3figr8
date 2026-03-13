/**
 * KUX TTS Recorder — Production (v2.0)
 * Dropdown Selection + Multi-Part Processing + Headless
 * 
 * Reads tts-input.json:
 * { "voice": "voice-donations/Andrea_(Spanish)_enhanced.wav", "parts": [{id:1, text:"..."}, ...] }
 * 
 * For each part → opens kyutai.org/tts → scrolls to 1.6B → checkbox → select voice → 
 * clear text → add text → play → wait download → save as part_N.wav
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_RETRIES = 3;

// ─── Read Input ───
const inputPath = path.join(__dirname, 'tts-input.json');
if (!fs.existsSync(inputPath)) { console.error('❌ tts-input.json not found!'); process.exit(1); }

const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const voice = input.voice || 'Show host (US, m)';
const parts = input.parts || [];

if (!parts.length) { console.error('❌ No parts in tts-input.json!'); process.exit(1); }

const downloadsDir = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

// Check if voice needs "Show all voices" checkbox (custom/repo voices)
const needsShowAll = voice.includes('/') || voice.includes('voice-donations') || voice.includes('expresso');

console.log(`🚀 KUX TTS Recorder v2.0`);
console.log(`🎤 Voice: ${voice}`);
console.log(`📦 Parts: ${parts.length}`);
console.log(`📁 Output: ${downloadsDir}`);
console.log(`☑️  Show All Voices: ${needsShowAll ? 'YES' : 'NO'}`);
console.log('');

(async () => {
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    const browser = await chromium.launch({ headless: isCI });
    const context = await browser.newContext({ 
        acceptDownloads: true, 
        viewport: { width: 1400, height: 900 } 
    });
    
    let successCount = 0;
    let failCount = 0;

    for (const part of parts) {
        let success = false;
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`🎬 [Part ${part.id}] Attempt ${attempt}/${MAX_RETRIES} — "${part.text.substring(0, 50)}..."`);
                
                const page = await context.newPage();
                
                // Step 1: Navigate
                await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForTimeout(3000);
                
                // Step 2: Scroll to 1.6B section
                await page.evaluate(() => window.scrollBy(0, 700));
                await page.waitForTimeout(1500);

                // Step 3: Click "Show all voices" checkbox if needed
                if (needsShowAll) {
                    const checkbox = page.locator('input[type="checkbox"]').nth(1);
                    if (await checkbox.count() > 0) {
                        await checkbox.check();
                        await page.waitForTimeout(2000);
                    }
                }

                // Step 4: Select voice from dropdown
                const voiceSelect = page.locator('select').nth(1);
                if (await voiceSelect.count() > 0) {
                    await voiceSelect.selectOption(voice);
                    await page.waitForTimeout(500);
                }
                
                // Step 5: Clear existing text + fill our text
                const textareas = await page.$$('textarea');
                const textarea = textareas[textareas.length - 1];
                if (!textarea) throw new Error('Textarea not found!');

                await textarea.click();
                await textarea.evaluate(el => { 
                    el.value = ''; 
                    el.dispatchEvent(new Event('input', { bubbles: true })); 
                });
                await textarea.fill(part.text);
                await page.waitForTimeout(500);

                // Step 6: Click Play button (last one = 1.6B section)
                const playButtons = await page.$$('button');
                let playBtn = null;
                for (const btn of playButtons) {
                    const text = await btn.textContent().catch(() => '');
                    if (text.trim() === 'Play') playBtn = btn;
                }
                if (!playBtn) throw new Error('Play button not found!');
                
                const playBox = await playBtn.boundingBox();
                await playBtn.click();
                console.log(`   ▶️  Play clicked!`);

                // Step 7: Wait for download button + click it
                const startTime = Date.now();
                let downloaded = false;

                while (Date.now() - startTime < 180000) { // 3 min max
                    const allBtns = await page.$$('button');
                    let downloadBtn = null;
                    
                    for (const btn of allBtns) {
                        const txt = await btn.textContent().catch(() => '');
                        if (txt.trim() === 'Play') continue;
                        const rect = await btn.boundingBox();
                        if (rect && playBox && 
                            rect.x > playBox.x && 
                            rect.x < (playBox.x + 150) && 
                            Math.abs(rect.y - playBox.y) < 15) {
                            downloadBtn = btn;
                            break;
                        }
                    }

                    if (downloadBtn) {
                        try {
                            const [dl] = await Promise.all([
                                page.waitForEvent('download', { timeout: 15000 }),
                                downloadBtn.click()
                            ]);
                            const fp = path.join(downloadsDir, `part_${part.id}.wav`);
                            await dl.saveAs(fp);
                            const sz = fs.statSync(fp).size;
                            console.log(`   ✅ Saved: part_${part.id}.wav (${(sz / 1024).toFixed(1)} KB)`);
                            downloaded = true;
                            break;
                        } catch {
                            // Download not ready yet, keep polling
                        }
                    }
                    
                    await page.waitForTimeout(1000);
                }

                if (!downloaded) throw new Error('Download timed out after 3 minutes');
                
                await page.close();
                success = true;
                successCount++;
                break; // Exit retry loop
                
            } catch (err) {
                console.log(`   ❌ Attempt ${attempt} failed: ${err.message}`);
                if (attempt === MAX_RETRIES) {
                    console.log(`   ⛔ Part ${part.id} FAILED after ${MAX_RETRIES} attempts!`);
                    failCount++;
                } else {
                    console.log(`   🔄 Retrying in 5s...`);
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }
    }

    await browser.close();
    
    console.log('');
    console.log('═══════════════════════════════════');
    console.log(`✅ Success: ${successCount}/${parts.length}`);
    console.log(`❌ Failed:  ${failCount}/${parts.length}`);
    console.log('═══════════════════════════════════');
    
    process.exit(failCount > 0 ? 1 : 0);
})();
