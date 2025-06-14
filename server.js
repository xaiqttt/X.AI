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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_ID = 'gemini-2.0-flash';
const memoryFile = 'memory.json';
const memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile)) : {};
const greetedUsers = new Set();

function saveMemory() {
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2));
}

app.get('/', (req, res) => res.send('X.AI Server is running'));

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

        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId, `I'm X.AI — an intelligent assistant developed by Darwin, powered by Google's Gemini 2.0 Flash. I currently support text-based conversations only. Image analysis is not enabled yet, as it requires a premium API.`);
        }

        const now = Date.now();
        const hourAgo = now - 3600000;

        if (!memory[senderId]) memory[senderId] = [];

        // Clean up old memory
        memory[senderId] = memory[senderId].filter(msg => msg.timestamp >= hourAgo);
        memory[senderId].push({ role: 'user', content: userText, timestamp: now });

        const contextMessages = memory[senderId].map(m => ({ role: 'user', content: m.content }));

        const aiReply = await askGemini(contextMessages);
        if (aiReply) {
          memory[senderId].push({ role: 'assistant', content: aiReply, timestamp: Date.now() });
          saveMemory();
          await sendMessage(senderId, aiReply);
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askGemini(messages) {
  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_ID}:generateContent?key=${GEMINI_API_KEY}`, {
      contents: messages.map(m => ({ parts: [{ text: m.content }] }))
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    return response.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  } catch (err) {
    console.error('AI Error:', err.response?.data || err.message);
    return 'Sorry, something went wrong with the AI.';
  }
}

async function sendMessage(recipientId, text) {
  try {
    await axios.post(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      recipient: { id: recipientId },
      message: { text }
    });
  } catch (err) {
    console.error('Messenger Error:', err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`X.AI is running on port ${PORT}`));
