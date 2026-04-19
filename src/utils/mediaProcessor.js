'use strict';
const { HfInference } = require('@huggingface/inference');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs/promises'); // Menggunakan promises
const path = require('path');
const crypto = require('crypto');

const hf = new HfInference(process.env.HF_TOKEN);
const tmpDir = '/tmp';

async function transcribeAudio(mediaObj) {
    // Gunakan UUID agar tidak tabrakan saat trafik tinggi
    const fileName = `${crypto.randomUUID()}.ogg`;
    const filePath = path.join(tmpDir, fileName);
    
    try {
        await fs.writeFile(filePath, Buffer.from(mediaObj.data, 'base64'));

        const audioBuffer = await fs.readFile(filePath);
        const result = await hf.automaticSpeechRecognition({
            model: 'openai/whisper-large-v3',
            data: audioBuffer,
            parameters: { language: 'id' }
        });

        return result.text ? result.text.trim() : '';
    } catch (err) {
        console.error('[MEDIA ERROR]', err.message);
        return '';
    } finally {
        try { await fs.unlink(filePath); } catch (e) {}
    }
}

async function extractTextFromImage(mediaObj) {
    const fileName = `${crypto.randomUUID()}.jpg`;
    const filePath = path.join(tmpDir, fileName);

    try {
        const buffer = Buffer.from(mediaObj.data, 'base64');
        const processedBuffer = await sharp(buffer)
            .grayscale()
            .normalize()
            .toBuffer();

        await fs.writeFile(filePath, processedBuffer);

        const { data: { text } } = await Tesseract.recognize(filePath, 'ind+eng');
        return text ? text.trim() : '';
    } catch (err) {
        console.error('[OCR ERROR]', err.message);
        return '';
    } finally {
        try { await fs.unlink(filePath); } catch (e) {}
    }
}

module.exports = { transcribeAudio, extractTextFromImage };