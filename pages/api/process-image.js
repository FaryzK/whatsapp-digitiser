import formidable from 'formidable';

// Add this at the top of your file
export const config = {
  api: {
    bodyParser: false, // Required for formidable
    maxDuration: 10, // Set max duration to 10 seconds
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    console.error('Server: Invalid method:', req.method);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Server: Starting image processing...');
    
    // Add request validation
    if (!req.headers['content-type']?.includes('multipart/form-data')) {
      console.error('Server: Invalid content type:', req.headers['content-type']);
      return res.status(400).json({ error: 'Invalid content type' });
    }

    const form = new formidable.IncomingForm({
      maxFileSize: 4 * 1024 * 1024, // 4MB limit
      allowEmptyFiles: false,
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error('Server: Form parsing error:', err);
        return res.status(500).json({ error: err.message || 'Form parsing failed' });
      }

      if (!files.image) {
        console.error('Server: No image file received');
        return res.status(400).json({ error: 'No image file received' });
      }

      const imageFile = files.image;
      
      // Add file type validation
      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(imageFile.mimetype)) {
        console.error('Server: Invalid file type:', imageFile.mimetype);
        return res.status(400).json({ error: 'Invalid file type' });
      }

      console.log('Server: Received image:', {
        name: imageFile.originalFilename,
        size: `${(imageFile.size / 1024 / 1024).toFixed(2)}MB`,
        type: imageFile.mimetype
      });

      // ... your image processing code ...

      console.log('Server: Image processing completed successfully');
      res.status(200).json({ success: true });
    });
  } catch (error) {
    console.error('Server: Processing error:', error);
    res.status(500).json({ error: error.message || 'Image processing failed' });
  }
} 