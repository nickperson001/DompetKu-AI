'use strict';
const { HfInference } = require('@huggingface/inference');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Inisialisasi Client Hugging Face
const hf = new HfInference(process.env.HF_TOKEN);

// Pastikan folder tmp ada
const tmpDir = path.join(__dirname, '../../tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

/**
 * Transkrip Audio (Voice Note) ke Text menggunakan Whisper Large v3
 */
async function transcribeAudio(mediaObj) {
  const fileName = `${Date.now()}_voice.ogg`;
  const filePath = path.join(tmpDir, fileName);
  
  try {
    // Simpan buffer audio ke file sementara
    fs.writeFileSync(filePath, Buffer.from(mediaObj.data, 'base64'));

    // Kirim ke Hugging Face
    const result = await hf.automaticSpeechRecognition({
      model: 'openai/whisper-large-v3',
      data: fs.readFileSync(filePath),
      parameters: { language: 'id' } // Optimasi Bahasa Indonesia
    });

    return result.text ? result.text.trim() : '';
  } catch (err) {
    console.error('[HF ERROR] Gagal transkrip audio:', err.message);
    return '';
  } finally {
    // Hapus file sementara agar tidak penuh
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

/**
 * Ekstrak Text dari Gambar (Nota) menggunakan Tesseract + Sharp
 */
async function extractTextFromImage(mediaObj) {
  const fileName = `${Date.now()}_receipt.jpg`;
  const filePath = path.join(tmpDir, fileName);

  try {
    const buffer = Buffer.from(mediaObj.data, 'base64');

    // Pre-processing gambar agar OCR akurat (Grayscale + Threshold)
    const processedBuffer = await sharp(buffer)
      .grayscale()
      .normalize()
      .threshold(128)
      .resize(2000, null, { withoutEnlargement: true }) // Resize agar tidak terlalu besar
      .toBuffer();

    fs.writeFileSync(filePath, processedBuffer);

    // Proses OCR
    const { data: { text } } = await Tesseract.recognize(
      filePath,
      'ind+eng', // Bahasa Indonesia + Inggris
      { logger: m => {} } // Matikan log verbose
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