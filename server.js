const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const accountRoutes = require('./routes/accounts');
const campaignRoutes = require('./routes/campaigns');
const settingRoutes = require('./routes/settings');
const shopifyRoutes = require('./routes/shopify');
const commentsRoutes = require('./routes/comments');

const app = express();
const port = process.env.PORT || 5000;

app.set('trust proxy', true);

// Setup multer for file uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/accounts', accountRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/shopify', shopifyRoutes);
app.use('/api/comments', commentsRoutes);

// Media upload endpoint
app.post('/api/media/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        res.json({ filePath: req.file.path, filename: req.file.filename });
    } catch (error) {
        res.status(500).json({ error: 'Upload failed', details: error.message });
    }
});

// Route to download video from URL and clean/process it using FFmpeg
app.post('/api/media/download-url', async (req, res) => {
    try {
        const { url, canvasType } = req.body; // canvasType is '9:16', '1:1', or 'original'
        if (!url) {
            return res.status(400).json({ error: 'Missing target URL' });
        }

        const videoProcessor = require('./services/videoProcessor');
        const outputFilename = `downloaded-${Date.now()}.mp4`;

        console.log(`Received download request for url: ${url}, canvasType: ${canvasType || 'original'}`);
        
        // 1. Download video
        const tempPath = await videoProcessor.downloadVideo(url, outputFilename);
        
        // 2. Reprocess video (scale, pad, strip, re-encode)
        const result = await videoProcessor.processVideo(tempPath, outputFilename, canvasType || 'original');
        
        res.json({
            success: true,
            filePath: result.filePath,
            filename: result.filename
        });
    } catch (error) {
        console.error("Failed to download and process video url:", error.message);
        res.status(500).json({ error: 'Video download or processing failed', details: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
});
