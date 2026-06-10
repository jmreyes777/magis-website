//magis-project/user-frontend/src/Shared/Utils-imageOptimization.js

/**
 * Optimize an image before upload: downscale to a max bounding box and
 * recompress via the browser Canvas API (PERF4-6).
 *
 * Output format is normalized to a type the chat upload endpoint already
 * allows (jpeg/png/gif) — it NEVER emits WebP, so this needs no change to the
 * backend file-type allow-list or any other security control:
 *   - GIF  -> returned untouched (canvas would flatten animation; already allowed)
 *   - PNG  -> stays PNG (preserves transparency)
 *   - anything else (JPEG/WebP/HEIC/...) -> JPEG (with a white matte for alpha)
 *
 * @param {File} file - The image file to optimize.
 * @param {Object} [options]
 * @param {number} [options.maxWidth=800]  - Max output width (px).
 * @param {number} [options.maxHeight=800] - Max output height (px).
 * @param {number} [options.quality=0.8]   - JPEG quality (0..1).
 * @returns {Promise<File>} the optimized file (or the original if already optimal).
 */
export const optimizeImage = async (
  file,
  { maxWidth = 800, maxHeight = 800, quality = 0.8 } = {}
) => {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Invalid file type. Please upload an image.');
  }

  // Animated GIFs can't be redrawn via canvas without losing animation, and
  // they're already an allowed type — pass through unchanged.
  if (file.type === 'image/gif') return file;

  // Always emit an allowed, well-compressed type: keep PNG (transparency),
  // otherwise normalize to JPEG (covers WebP/HEIC/BMP/etc.).
  const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const outputExt = outputType === 'image/png' ? 'png' : 'jpg';
  const baseName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  const outputName = `${baseName}.${outputExt}`;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();

      img.onload = () => {
        let { width, height } = img;
        const origWidth = width;
        const origHeight = height;

        // Downscale to fit within the max box, preserving aspect ratio.
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.max(1, Math.round(width * ratio));
          height = Math.max(1, Math.round(height * ratio));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // JPEG has no alpha — paint a white matte so transparent source images
        // don't get a black background.
        if (outputType === 'image/jpeg') {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Image compression failed.'));
              return;
            }
            const resized = origWidth > maxWidth || origHeight > maxHeight;
            // If no resize was needed, the source was already an allowed type,
            // and re-encoding didn't shrink it — keep the original bytes.
            if (!resized && outputType === file.type && blob.size >= file.size) {
              resolve(file);
              return;
            }
            resolve(
              new File([blob], outputName, {
                type: outputType,
                lastModified: Date.now(),
              })
            );
          },
          outputType,
          quality
        );
      };

      img.onerror = () => reject(new Error('Failed to load the image.'));
      img.src = event.target.result;
    };

    reader.onerror = () => reject(new Error('Failed to read the file.'));
    reader.readAsDataURL(file);
  });
};
