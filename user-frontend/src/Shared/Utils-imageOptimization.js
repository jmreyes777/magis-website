//magis-project/user-frontend/src/Shared/Utils-imageOptimization.js

/**
 * Optimize an image by resizing and compressing it before upload.
 * Uses the browser's `Canvas` API to process the image.
 *
 * @param {File} file - The image file to be optimized.
 * @param {Object} [options] - Optional parameters for optimization.
 * @param {number} [options.maxWidth=800] - Maximum width of the output image.
 * @param {number} [options.maxHeight=800] - Maximum height of the output image.
 * @param {number} [options.quality=0.8] - Quality of the output image (0 to 1).
 * @returns {Promise<File>} - Returns a Promise that resolves with the optimized file.
 */
export const optimizeImage = async (
  file,
  { maxWidth = 800, maxHeight = 800, quality = 0.8 } = {}
) => {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Invalid file type. Please upload an image.');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;

      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        let { width, height } = img;

        // Skip resizing if dimensions are smaller than the target
        if (width <= maxWidth && height <= maxHeight) {
          console.warn('Image dimensions are within the limits. Skipping resizing.');
        } else {
          // Adjust dimensions while maintaining aspect ratio
          const aspectRatio = width / height;
          if (width > height) {
            width = maxWidth;
            height = maxWidth / aspectRatio;
          } else {
            height = maxHeight;
            width = maxHeight * aspectRatio;
          }
        }

        // Resize and compress
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Image compression failed.'));
              return;
            }
            const optimizedFile = new File([blob], file.name, {
              type: file.type,
              lastModified: Date.now(),
            });
            resolve(optimizedFile);
          },
          file.type === 'image/webp' ? 'image/webp' : file.type, // Default to WebP if supported
          quality
        );
      };

      img.onerror = () => reject(new Error('Failed to load the image.'));
    };

    reader.onerror = () => reject(new Error('Failed to read the file.'));
    reader.readAsDataURL(file);
  });
};
