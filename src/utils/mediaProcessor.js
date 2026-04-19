'use strict';

const { HfInference } = require('@huggingface/inference');
const Tesseract = require('tesseract.js');
const sharp  = require('sharp');
const fs     = require('fs/promises'); // ✅ Non-blocking async I/O
const path   = require('path');
const crypto = require('crypto');      // ✅ UUID agar tidak tabrakan

const hf     = new HfInference(process.env.HF_TOKEN);
const tmpDir = '/tmp'; // ✅ Railway-safe, selalu writable

// ════════════════════════════════════════════════════════════
// TRANSKRIP AUDIO (Voice Note) → Text menggunakan Whisper
// ════════════════════════════════════════════════════════════
async function transcribeAudio(mediaObj) {
    if (!process.env.HF_TOKEN) {
        console.warn('[MEDIA] HF_TOKEN tidak diset — audio transcription skip');
        return '';
    }

    const fileName = `${crypto.randomUUID()}.ogg`; // ✅ UUID aman di trafik tinggi
    const filePath = path.join(tmpDir, fileName);

    try {
        await fs.writeFile(filePath, Buffer.from(mediaObj.data, 'base64'));
        const audioBuffer = await fs.readFile(filePath);

        const result = await hf.automaticSpeechRecognition({
            model     : 'openai/whisper-large-v3',
            data      : audioBuffer,
            parameters: { language: 'id' },
        });

        return result.text ? result.text.trim() : '';
    } catch (err) {
        console.error('[MEDIA] Transkrip audio gagal:', err.message);
        return '';
    } finally {
        try { await fs.unlink(filePath); } catch (_) {} // ✅ Cleanup aman
    }
}

// ════════════════════════════════════════════════════════════
// EKSTRAK TEXT DARI GAMBAR (Nota/Receipt) menggunakan OCR
// ════════════════════════════════════════════════════════════
async function extractTextFromImage(mediaObj) {
    const fileName = `${crypto.randomUUID()}.jpg`; // ✅ UUID
    const filePath = path.join(tmpDir, fileName);

    try {
        const rawBuffer = Buffer.from(mediaObj.data, 'base64');

        // Pre-processing: grayscale + normalize untuk akurasi OCR
        const processedBuffer = await sharp(rawBuffer)
            .grayscale()
            .normalize()
            .toBuffer();

        await fs.writeFile(filePath, processedBuffer);

        const { data: { text } } = await Tesseract.recognize(
            filePath,
            'ind+eng', // Bahasa Indonesia + Inggris
            { logger: () => {} } // Matikan log verbose
        );

        return text ? text.trim() : '';
    } catch (err) {
        console.error('[OCR] Ekstrak gambar gagal:', err.message);
        return '';
    } finally {
        try { await fs.unlink(filePath); } catch (_) {} // ✅ Cleanup aman
    }
}

module.exports = { transcribeAudio, extractTextFromImage };