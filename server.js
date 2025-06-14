import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Confirm all required API keys are loaded
console.log('PAGE_ACCESS_TOKEN:', PAGE_ACCESS_TOKEN ? '✅ Loaded' : '❌ Missing');
console.log('VERIFY_TOKEN:', VERIFY_TOKEN ? '✅ Loaded' : '❌ Missing');
console.log('OPENROUTER_API_KEY:', OPENROUTER_API_KEY ? '✅ Loaded' : '❌ Missing');

if (!PAGE_ACCESS_TOKEN || !VERIFY_TOKEN || !OPENROUTER_API_KEY) {
  console.error('❌ Missing one or more required environment variables. Exiting...');
  process.exit(1);
}

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
        const userText = event.message.text;

        if (!greetedUsers.has(senderId)) {
          greetedUsers.add(senderId);
          await sendMessage(senderId, `Hi, I'm X.AI. I was created by Darwin. I'm powered by the mistralai/mixtral-8x7b-instruct model via OpenRouter. I only support text for now because image features require additional APIs that aren't free.`);
        }

        const aiReply = await askAI(userText);
        await sendMessage(senderId, aiReply);
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function askAI(prompt) {
  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: 'mistralai/mixtral-8x7b-instruct',
      messages: [
        { role: 'user', content: prompt }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error('AI Error:', err?.response?.data || err.message);
    return 'Sorry, I could not process your request right now.';
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`X.AI is running on port ${PORT}`);
});
