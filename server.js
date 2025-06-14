const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const geminiApiVision = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${GEMINI_API_KEY}`;
const geminiApiText = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

// ===== Webhook verification =====
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ===== Handle incoming messages =====
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      for (const event of entry.messaging) {
        const sender_psid = event.sender.id;

        if (event.message) {
          if (event.message.attachments && event.message.attachments[0].type === 'image') {
            const imageUrl = event.message.attachments[0].payload.url;
            await handleImageMessage(sender_psid, imageUrl);
          } else if (event.message.text) {
            await handleTextMessage(sender_psid, event.message.text);
          }
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// ===== Handle image messages =====
async function handleImageMessage(sender_psid, imageUrl) {
  try {
    const base64Image = await fetchBase64(imageUrl);

    const response = await axios.post(geminiApiVision, {
      contents: [
        {
          parts: [
            { text: 'What can you see in this image? Answer conversationally.' },
            {
              inline_data: {
                mime_type: 'image/jpeg',
                data: base64Image,
              },
            },
          ],
        },
      ],
    });

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not understand the image.';
    await sendMessage(sender_psid, reply);
  } catch (err) {
    console.error('Error (image):', err.message);
    await sendMessage(sender_psid, '❌ Error analyzing image.');
  }
}

// ===== Handle text messages =====
async function handleTextMessage(sender_psid, text) {
  try {
    const response = await axios.post(geminiApiText, {
      contents: [{ parts: [{ text }] }],
    });

    const reply = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'I’m not sure how to respond to that.';
    await sendMessage(sender_psid, reply);
  } catch (err) {
    console.error('Error (text):', err.message);
    await sendMessage(sender_psid, '❌ I couldn’t process that.');
  }
}

// ===== Send message back to user =====
async function sendMessage(sender_psid, message) {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: sender_psid },
      message: { text: message },
    });
  } catch (err) {
    console.error('Send error:', err.response?.data || err.message);
  }
}

// ===== Convert image URL to base64 =====
async function fetchBase64(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data, 'binary').toString('base64');
}

app.listen(PORT, () => {
  console.log(`🚀 X.AI by Darwin aka xai is running on port ${PORT}`);
});
