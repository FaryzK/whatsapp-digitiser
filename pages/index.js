const handleImageUpload = async (event) => {
  try {
    console.log('Client: Starting image upload...', event.target.files[0]);
    const file = event.target.files[0];
    
    // Add file validation
    if (!file) {
      console.error('Client: No file selected');
      throw new Error('Please select a file');
    }

    // Add size validation (e.g., 4MB limit for Vercel)
    const MAX_SIZE = 4 * 1024 * 1024; // 4MB in bytes
    if (file.size > MAX_SIZE) {
      console.error('Client: File too large:', `${(file.size / 1024 / 1024).toFixed(2)}MB`);
      throw new Error('File size must be less than 4MB');
    }

    // Add type validation
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      console.error('Client: Invalid file type:', file.type);
      throw new Error('Only JPEG, PNG, and WebP images are allowed');
    }

    console.log('Client: Image details:', {
      name: file.name,
      size: `${(file.size / 1024 / 1024).toFixed(2)}MB`,
      type: file.type
    });

    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch('/api/process-image', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      console.error('Client: Server responded with error:', response.status);
      const errorText = await response.text();
      console.error('Client: Error details:', errorText);
      throw new Error(`Server error: ${response.status}`);
    }

    const data = await response.json();
    console.log('Client: Processing successful:', data);
    // ... rest of your success handling code ...
  } catch (error) {
    console.error('Client: Error during upload:', error);
    // Add user feedback here
    alert(error.message || 'Failed to process image');
    // ... your error handling code ...
  }
}; 