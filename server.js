const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let ALLOWED_IDS = [
  '1234567890123456', // Darwin aka xai
  '2345678901234567', // friend 1
  '3456789012345678'  // friend 2
];

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ X.AI webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.sendStatus(404);

  for (const entry of body.entry) {
    const event = entry.messaging[0];
    const senderId = event.sender.id;

    console.log('💬 New message from:', senderId);

    if (!ALLOWED_IDS.includes(senderId)) {
      console.log('⛔ Rejected sender:', senderId);
      return;
    }

    if (event.message?.text) {
      const msg = event.message.text.trim().toLowerCase();

      if (msg === 'id') {
        return sendText(senderId, `🪪 Your PSID is: ${senderId}`);
      }

      const reply = await askGemini(msg);
      return sendText(senderId, `🤖 X.AI: ${reply}`);
    }

    if (event.message?.attachments?.[0]?.type === 'image') {
      const imageUrl = event.message.attachments[0].payload.url;
      const userText = event.message.text || 'What’s in this image?';
      const reply = await askGeminiWithImage(imageUrl, userText);
      return sendText(senderId, `🖼️ X.AI: ${reply}`);
    }
  }

  res.sendStatus(200);
});

async function askGemini(prompt) {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      }
    );
    return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '🤖 No answer.';
  } catch {
    return '⚠️ Gemini error.';
  }
}

async function askGeminiWithImage(imageUrl, prompt) {
  try {
    const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64Image = Buffer.from(imageRes.data).toString('base64');

    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image
              }
            },
            { text: prompt }
          ]
        }]
      }
    );
    return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '🤖 No reply.';
  } catch {
    return '⚠️ Gemini image error.';
  }
}

async function sendText(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      message: { text }
    });
  } catch (e) {
    console.error('❌ Failed to send message:', e.response?.data || e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 X.AI by Darwin (xai) running on port ${PORT}`));
