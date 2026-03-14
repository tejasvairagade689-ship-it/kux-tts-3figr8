/**
 * KUX TTS Recorder — v3.2 TURBO
 * Page Reuse + Auto-Retry + Strict Selector (1.6B)
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
console.log('🚀 KUX TTS Recorder v3.2 TURBO');
console.log(`🎤 Voice: ${voice}`);
console.log(`📦 Parts: ${parts.length}`);
console.log('═══════════════════════════════════');

(async () => {
    const globalStart = Date.now();
    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
    const browser = await chromium.launch({ headless: isCI });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });

    const attempts = {};
    parts.forEach(p => { attempts[p.id] = 0; });
    const completed = new Set();
    
    // ═══════════════════════════════════
    // SETUP PAGE (Targets 1.6B strictly)
    // ═══════════════════════════════════
    async function setupPage() {
        const page = await context.newPage();
        for (let i = 0; i < 3; i++) {
            try {
                await page.goto(TTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
                break;
            } catch (e) {
                if (i === 2) throw e;
                await new Promise(r => setTimeout(r, 3000));
            }
        }
        await page.waitForTimeout(2500);
        
        // Strict Model Selection
        try {
            await page.click('text="Kyutai 1.6B"');
        } catch (e) {
            await page.click('text="Kyutai TTS 1.6B"').catch(()=>{});
        }
        await page.waitForTimeout(2000);
        
        const baseSelector = 'section:has-text("Kyutai 1.6B")';
        const section = page.locator(baseSelector).last();
        
        if (needsShowAll) {
            const checkbox = section.locator('input[type="checkbox"]').first();
            if (await checkbox.count() > 0) {
                await checkbox.check();
                await page.waitForTimeout(2000);
            }
        }
        
        const voiceSelect = section.locator('select').first();
        if (await voiceSelect.count() > 0) {
            await voiceSelect.selectOption(voice);
            await page.waitForTimeout(500);
        }
        
        return { page, section, baseSelector };
    }
    
    // ═══════════════════════════════════
    // PROCESS SINGLE PART
    // ═══════════════════════════════════
    async function processPart(page, section, part) {
        const textarea = section.locator('textarea').first();
        if (await textarea.count() === 0) throw new Error('1.6B Textarea not found!');
        
        await textarea.click();
        await textarea.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.waitForTimeout(200);
        await textarea.fill(part.text);
        await page.waitForTimeout(300);
        
        let playBtn = section.locator('button:has-text("Play")').first();
        if (await playBtn.count() === 0) playBtn = section.locator('button:has-text("Generate")').first();
        if (await playBtn.count() === 0) throw new Error('1.6B Play button not found!');
        
        const playBox = await playBtn.boundingBox();
        await playBtn.click();
        
        const startTime = Date.now();
        while (Date.now() - startTime < DOWNLOAD_TIMEOUT) {
            const allBtns = await section.locator('button').all();
            let downloadBtn = null;
            for (const btn of allBtns) {
                const txt = await btn.textContent().catch(() => '');
                if (txt.trim() === 'Play' || txt.trim() === 'Generate') continue;
                const rect = await btn.boundingBox();
                if (rect && playBox && rect.x > playBox.x && rect.x < playBox.x + 150 && Math.abs(rect.y - playBox.y) < 20) {
                    downloadBtn = btn;
                    break;
                }
            }
            
            if (downloadBtn) {
                try {
                    const [dl] = await Promise.all([
                        page.waitForEvent('download', { timeout: 20000 }),
                        downloadBtn.click()
                    ]);
                    const fp = path.join(downloadsDir, `part_${part.id}.wav`);
                    await dl.saveAs(fp);
                    const sz = fs.statSync(fp).size;
                    if (sz < 500) throw new Error('File too small');
                    return { success: true, size: sz };
                } catch (e) {
                    if (Date.now() - startTime > DOWNLOAD_TIMEOUT - 10000) throw new Error('Download failed');
                }
            }
            await page.waitForTimeout(800);
        }
        throw new Error('Download timed out');
    }
    
    // ═══════════════════════════════════
    // MAIN LOOP
    // ═══════════════════════════════════
    let pageObj = null;
    let roundNum = 0;
    
    while (completed.size < parts.length) {
        roundNum++;
        const pending = parts.filter(p => !completed.has(p.id));
        if (!pending.length) break;

        if (pending.every(p => attempts[p.id] >= MAX_ATTEMPTS_PER_PART)) break;

        if (!pageObj || pageObj.page.isClosed()) {
            try {
                pageObj = await setupPage();
            } catch (e) {
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
        }
        
        for (const part of pending) {
            if (completed.has(part.id) || attempts[part.id] >= MAX_ATTEMPTS_PER_PART) continue;
            attempts[part.id]++;
            
            try {
                const res = await processPart(pageObj.page, pageObj.section, part);
                completed.add(part.id);
                console.log(`✅ Part ${part.id} Done`);
                await pageObj.page.waitForTimeout(1000);
            } catch (err) {
                console.log(`❌ Part ${part.id} Failed: ${err.message}`);
                // Refresh page on hard errors
                if (err.message.includes('closed') || err.message.includes('timeout')) {
                    try { await pageObj.page.close(); } catch {}
                    pageObj = null;
                    break; 
                }
            }
        }
    }
    
    await browser.close();
    process.exit(completed.size === parts.length ? 0 : 1);
})();
