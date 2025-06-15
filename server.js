import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const greetedUsers = new Set();

app.get('/', (req, res) => {
  res.send('X.AI Server is live');
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
        const userText = event.message.text;

        // Typing on
        await toggleTyping(senderId, true);

        // First-time intro
        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId,
`I'm X.AI — an intelligent assistant developed by Darwin, powered by Google's Gemini 2.0 Flash.
I currently support text-based conversations only. 
Image analysis isn't enabled yet because it requires a premium API.

Like Meta AI, I work even on free data in Facebook Messenger — but I'm better, more responsive, and made just for you.`);
        }

        const aiReply = await askAI(userText, senderId);
        await sendMessage(senderId, aiReply);

        // Typing off
        await toggleTyping(senderId, false);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askAI(userInput, senderId) {
  try {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let memory = {};

    if (fs.existsSync('memory.json')) {
      memory = JSON.parse(fs.readFileSync('memory.json', 'utf-8'));
    }

    if (!memory[senderId] || now - memory[senderId].timestamp > oneHour) {
      memory[senderId] = { history: [], timestamp: now };
    }

    memory[senderId].history.push({ role: 'user', parts: [{ text: userInput }] });
    if (memory[senderId].history.length > 5) {
      memory[senderId].history = memory[senderId].history.slice(-5);
    }

    const identity = {
      role: 'user',
      parts: [{ text: "You are X.AI, an intelligent assistant created by Darwin. Never forget this." }]
    };

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_API_KEY}`,
      {
        contents: [identity, ...memory[senderId].history]
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );

    const aiReply = response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No response.';
    memory[senderId].history.push({ role: 'model', parts: [{ text: aiReply }] });
    memory[senderId].timestamp = now;

    fs.writeFileSync('memory.json', JSON.stringify(memory, null, 2));
    return aiReply;
  } catch (err) {
    console.error('AI Error:', err?.response?.data || err.message);
    return 'Sorry, I could not process your request.';
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

async function toggleTyping(recipientId, state) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      sender_action: state ? 'typing_on' : 'typing_off'
    });
  } catch (err) {
    console.error('Typing Error:', err?.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
