'use strict';
const { HfInference } = require('@huggingface/inference');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const hf = new HfInference(process.env.HF_TOKEN);

// FIX: tmpDir Railway-safe
const tmpDir = '/tmp';
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

async function transcribeAudio(mediaObj) {
    const fileName = `${Date.now()}_voice.ogg`;
    const filePath = path.join(tmpDir, fileName);
    
    try {
        fs.writeFileSync(filePath, Buffer.from(mediaObj.data, 'base64'));

        const result = await hf.automaticSpeechRecognition({
            model: 'openai/whisper-large-v3',
            data: fs.readFileSync(filePath),
            parameters: { language: 'id' }
        });

        return result.text ? result.text.trim() : '';
    } catch (err) {
        console.error('[HF ERROR] Gagal transkrip audio:', err.message);
        return '';
    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

async function extractTextFromImage(mediaObj) {
    const fileName = `${Date.now()}_receipt.jpg`;
    const filePath = path.join(tmpDir, fileName);

    try {
        const buffer = Buffer.from(mediaObj.data, 'base64');

        const processedBuffer = await sharp(buffer)
            .grayscale()
            .normalize()
            .threshold(128)
            .resize(2000, null, { withoutEnlargement: true })
            .toBuffer();

        fs.writeFileSync(filePath, processedBuffer);

        const { data: { text } } = await Tesseract.recognize(
            filePath,
            'ind+eng',
            { 
                langPath: path.join(__dirname, '..', '..', 'tessdata'),
                logger: () => {} 
            }
        );

        return text ? text.trim() : '';
    } catch (err) {
        console.error('[OCR ERROR] Gagal ekstrak text gambar:', err.message);
        return '';
    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

module.exports = { transcribeAudio, extractTextFromImage };