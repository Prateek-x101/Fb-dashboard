const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const accountRoutes = require('./routes/accounts');
const campaignRoutes = require('./routes/campaigns');
const settingRoutes = require('./routes/settings');

const app = express();
const port = process.env.PORT || 5000;

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

// Routes
app.use('/api/accounts', accountRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/settings', settingRoutes);

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
