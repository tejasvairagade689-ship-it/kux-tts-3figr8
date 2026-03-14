/**
 * KUX TTS Recorder — v3.0 TURBO
 * Page Reuse + Auto-Retry Until 100% + Speed Optimized
 * 
 * Key optimizations:
 * - Page reuse: load once, process all parts (saves ~12 sec/part)
 * - Auto-retry: failed parts retry until ALL succeed (max 10 attempts each)
 * - Fast polling: 500ms download detection
 * - Reduced waits: minimal timeouts
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TTS_URL = 'https://kyutai.org/tts';
const MAX_ATTEMPTS_PER_PART = 10;
const DOWNLOAD_TIMEOUT = 300000; // 5 min per part

// ─── Read Input ───
const inputPath = path.join(__dirname, 'tts-input.json');
if (!fs.existsSync(inputPath)) { console.error('❌ tts-input.json not found!'); process.exit(1); }

const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
const voice = input.voice || 'Show host (US, m)';
const parts = input.parts || [];

if (!parts.length) { console.error('❌ No parts in tts-input.json!'); process.exit(1); }

const downloadsDir = path.join(__dirname, '..', 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const needsShowAll = voice.includes('/') || voice.includes('voice-donations') || voice.includes('expresso');

console.log('═══════════════════════════════════');
console.log('🚀 KUX TTS Recorder v3.0 TURBO');
console.log('═══════════════════════════════════');
console.log(`🎤 Voice: ${voice}`);
console.log(`📦 Parts: ${parts.length}`);
console.log(`📁 Output: ${downloadsDir}`);
console.log(`☑️  Show All: ${needsShowAll ? 'YES' : 'NO'}`);
console.log(`🔄 Max Retries: ${MAX_ATTEMPTS_PER_PART} per part`);
console.log('');

(async () => {
    const globalStart = Date.now();
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    const browser = await chromium.launch({ headless: isCI });
    const context = await browser.newContext({ 
        acceptDownloads: true, 
        viewport: { width: 1400, height: 900 } 
    });

    // Track attempts per part
    const attempts = {};
    parts.forEach(p => { attempts[p.id] = 0; });
    
    // Track which parts are done
    const completed = new Set();
    
    // ═══════════════════════════════════
    // SETUP PAGE (load once, reuse)
    // ═══════════════════════════════════
    async function setupPage() {
        const page = await context.newPage();
        
        // Navigate with retry
        for (let i = 0; i < 3; i++) {
            try {
                await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                break;
            } catch (e) {
                if (i === 2) throw e;
                console.log(`   🔄 Page load retry ${i + 1}...`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }
        
        await page.waitForTimeout(3000);
        
        // Scroll to 1.6B section specifically
        try {
            const heading = page.locator('text=Kyutai TTS 1.6B').first();
            await heading.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1000);
        } catch {
            await page.evaluate(() => window.scrollBy(0, 700));
            await page.waitForTimeout(1000);
        }
        
        // Checkbox
        if (needsShowAll) {
            const checkbox = page.locator('input[type="checkbox"]').nth(1);
            if (await checkbox.count() > 0) {
                await checkbox.check();
                await page.waitForTimeout(1500);
            }
        }
        
        // Select voice
        const voiceSelect = page.locator('select').nth(1);
        if (await voiceSelect.count() > 0) {
            await voiceSelect.selectOption(voice);
            await page.waitForTimeout(500);
        }
        
        console.log('✅ Page setup complete (voice selected, checkbox checked)');
        return page;
    }
    
    // ═══════════════════════════════════
    // PROCESS SINGLE PART (on existing page)
    // ═══════════════════════════════════
    async function processPart(page, part) {
        // Clear + fill text — nth(1) = 2nd textarea = 1.6B section
        const textarea = page.locator('textarea').nth(1);
        if (await textarea.count() === 0) throw new Error('1.6B Textarea not found!');
        
        await textarea.click();
        await textarea.evaluate(el => { 
            el.value = ''; 
            el.dispatchEvent(new Event('input', { bubbles: true })); 
        });
        await page.waitForTimeout(200);
        await textarea.fill(part.text);
        await page.waitForTimeout(300);
        
        // Find Play button — 2nd Play button = 1.6B section
        const allButtons = await page.$$('button');
        const playBtns = [];
        for (const btn of allButtons) {
            const text = await btn.textContent().catch(() => '');
            if (text.trim() === 'Play') playBtns.push(btn);
        }
        const playBtn = playBtns.length >= 2 ? playBtns[1] : playBtns[playBtns.length - 1];
        if (!playBtn) throw new Error('1.6B Play button not found!');
        
        const playBox = await playBtn.boundingBox();
        if (!playBox) throw new Error('Play button not visible!');
        
        await playBtn.click();
        
        // Fast poll for download button (500ms intervals, 5 min max)
        const startTime = Date.now();
        
        while (Date.now() - startTime < DOWNLOAD_TIMEOUT) {
            const allBtns = await page.$$('button');
            let downloadBtn = null;
            
            for (const btn of allBtns) {
                const txt = await btn.textContent().catch(() => '');
                if (txt.trim() === 'Play') continue;
                const rect = await btn.boundingBox();
                if (rect && playBox && 
                    rect.x > playBox.x && 
                    rect.x < (playBox.x + 150) && 
                    Math.abs(rect.y - playBox.y) < 20) {
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
                    if (sz < 1000) throw new Error('File too small, likely empty');
                    return { success: true, size: sz };
                } catch (e) {
                    // Download click failed, maybe still generating
                    if (Date.now() - startTime > DOWNLOAD_TIMEOUT - 5000) {
                        throw new Error('Download failed after timeout');
                    }
                }
            }
            
            await page.waitForTimeout(500); // Fast poll
        }
        
        throw new Error('Download timed out after 5 minutes');
    }
    
    // ═══════════════════════════════════
    // MAIN LOOP: Process all parts with auto-retry
    // ═══════════════════════════════════
    let page = null;
    let roundNum = 0;
    let partsProcessedSinceRefresh = 0;
    const CHUNKS_PER_REFRESH = 5;
    
    while (completed.size < parts.length) {
        roundNum++;
        const pending = parts.filter(p => !completed.has(p.id));
        
        console.log(`\n🔁 Round ${roundNum}: ${pending.length} parts remaining (${completed.size}/${parts.length} done)`);
        
        // Check if any part has exceeded max attempts
        const hopeless = pending.filter(p => attempts[p.id] >= MAX_ATTEMPTS_PER_PART);
        if (hopeless.length === pending.length) {
            console.log(`\n⛔ All remaining parts exceeded ${MAX_ATTEMPTS_PER_PART} attempts. Giving up.`);
            break;
        }
        
        // Check if we need to force a refresh (after 5 chunks)
        if (page && partsProcessedSinceRefresh >= CHUNKS_PER_REFRESH) {
            console.log(`\n🔄 Force refreshing page after ${CHUNKS_PER_REFRESH} parts (batch limit)...`);
            try { await page.close(); } catch {}
            page = null;
            partsProcessedSinceRefresh = 0;
        }

        // Setup or reuse page
        if (!page || page.isClosed()) {
            try {
                page = await setupPage();
                partsProcessedSinceRefresh = 0;
            } catch (e) {
                console.log(`❌ Page setup failed: ${e.message}. Retrying in 10s...`);
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
        }
        
        for (const part of pending) {
            if (completed.has(part.id)) continue;
            if (attempts[part.id] >= MAX_ATTEMPTS_PER_PART) continue;
            
            attempts[part.id]++;
            const elapsed = ((Date.now() - globalStart) / 1000).toFixed(0);
            console.log(`🎬 [Part ${part.id}] Attempt ${attempts[part.id]}/${MAX_ATTEMPTS_PER_PART} (${elapsed}s elapsed) — "${part.text.substring(0, 40)}..."`);
            
            try {
                const result = await processPart(page, part);
                completed.add(part.id);
                partsProcessedSinceRefresh++;
                console.log(`   ✅ part_${part.id}.wav (${(result.size / 1024).toFixed(1)} KB) — ${completed.size}/${parts.length} done`);
                
                // Small pause between parts (let page settle)
                await page.waitForTimeout(1000);
                
            } catch (err) {
                console.log(`   ❌ Failed: ${err.message}`);
                
                // If page crashed or timed out, close and create fresh page
                if (err.message.includes('closed') || err.message.includes('Target') || 
                    err.message.includes('timed out') || err.message.includes('not found') ||
                    err.message.includes('not visible')) {
                    console.log(`   🔄 Page refresh needed...`);
                    try { await page.close(); } catch {}
                    page = null;
                    
                    // Re-setup page for next attempt
                    try {
                        page = await setupPage();
                    } catch (e) {
                        console.log(`   ❌ Page re-setup failed: ${e.message}`);
                        page = null;
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
            }
        }
        
        // If still have pending parts, wait a bit before next round
        if (completed.size < parts.length) {
            const remaining = parts.filter(p => !completed.has(p.id) && attempts[p.id] < MAX_ATTEMPTS_PER_PART);
            if (remaining.length > 0) {
                console.log(`\n⏳ ${remaining.length} parts need retry. Waiting 5s before round ${roundNum + 1}...`);
                
                // Fresh page for retry round
                try { if (page) await page.close(); } catch {}
                page = null;
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
    
    // Cleanup
    try { if (page && !page.isClosed()) await page.close(); } catch {}
    await browser.close();
    
    const totalTime = ((Date.now() - globalStart) / 1000).toFixed(1);
    const failedParts = parts.filter(p => !completed.has(p.id));
    
    console.log('');
    console.log('═══════════════════════════════════');
    console.log(`⏱️  Total Time: ${totalTime}s`);
    console.log(`✅ Success: ${completed.size}/${parts.length}`);
    if (failedParts.length > 0) {
        console.log(`❌ Failed:  ${failedParts.length}/${parts.length} (IDs: ${failedParts.map(p => p.id).join(', ')})`);
    }
    console.log('═══════════════════════════════════');
    
    // Exit 0 if any parts succeeded (partial success is OK)
    // Failed parts can be retried from the webapp
    process.exit(failedParts.length === parts.length ? 1 : 0);
})();
