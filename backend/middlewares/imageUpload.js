const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// Define acceptable file types
const allowedFileTypes = ['image/jpeg', 'image/png', 'image/webp'];

// Configure Multer for file storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (allowedFileTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and WEBP are allowed.'));
    }
  },
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB file size limit
  },
});

// Middleware to handle image processing and optimization
const processImage = async (req, res, next) => {
  if (!req.file) {
    return next(); // Skip if no file uploaded
  }

  try {
    // Define the optimized file name and path
    const optimizedFileName = `${Date.now()}-${req.file.originalname.replace(/\s+/g, '-')}`;
    const optimizedFilePath = path.join(__dirname, '../uploads', optimizedFileName);

    // Ensure the uploads directory exists
    if (!fs.existsSync(path.join(__dirname, '../uploads'))) {
      fs.mkdirSync(path.join(__dirname, '../uploads'));
    }

    // Optimize and convert the image to WebP format for better compression
    await sharp(req.file.buffer)
      .resize({ width: 800, height: 800, fit: 'inside' }) // Resize to a max of 800x800 while maintaining aspect ratio
      .toFormat('webp')
      .webp({ quality: 80 }) // Set quality to 80%
      .toFile(optimizedFilePath);

    // Attach the optimized file details to the request object
    req.optimizedImage = {
      path: optimizedFilePath,
      filename: optimizedFileName,
    };

    next();
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).json({ error: 'Failed to process the image.' });
  }
};

module.exports = {
  upload,
  processImage,
};