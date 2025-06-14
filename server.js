import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const greetedUsers = new Set();

app.get('/', (req, res) => {
  res.send('X.AI Server is running');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      const event = entry.messaging[0];
      const senderId = event.sender.id;

      if (event.message && event.message.text) {
        const userText = event.message.text.trim();

        await sendTyping(senderId, true);

        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId, `I'm X.AI — an intelligent assistant developed by Darwin, powered by Google's Gemini 2.0 Flash. I currently support text-based conversations only. Image analysis is not enabled yet, as it requires a premium API.`);
        }

        const aiReply = await askGemini(userText);
        await sendMessage(senderId, aiReply);

        await sendTyping(senderId, false);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askGemini(prompt) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'I couldn’t understand that.';
  } catch (err) {
    console.error('Gemini Flash Error:', err?.response?.data || err.message);
    return 'Sorry, I’m having trouble responding right now.';
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      message: { text }
    });
  } catch (err) {
    console.error('Messenger Error:', err?.response?.data || err.message);
  }
}

async function sendTyping(recipientId, isTyping) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      sender_action: isTyping ? 'typing_on' : 'typing_off'
    });
  } catch (err) {
    console.error('Typing Error:', err?.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
