const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
  res.json({ status: 'Summify backend running' });
});

app.post('/extract-pdf', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) {
      return res.status(400).json({ error: 'No base64 data provided' });
    }

    const buffer = Buffer.from(base64, 'base64');
    
    const { default: pdfParse } = await import('pdf-parse');
    const data = await pdfParse(buffer);
    const text = data.text?.trim();

    if (!text || text.length < 100) {
      return res.status(422).json({
        error: 'Could not extract text from this PDF.',
      });
    }

    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: 'PDF processing failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
