// Port of user-frontend Shared/Utils-imageOptimization.js (PERF4-6) for the
// branch chat composer — keep the two in sync if the allow-list changes.
//
// Optimize an image before upload: downscale to a max bounding box and
// recompress via the browser Canvas API. Output is normalized to a type the
// chat upload endpoint already allows (jpeg/png/gif) — NEVER WebP:
//   - GIF  -> returned untouched (canvas would flatten animation)
//   - PNG  -> stays PNG (preserves transparency)
//   - anything else (JPEG/WebP/HEIC/...) -> JPEG (white matte for alpha)

export const optimizeImage = async (
  file,
  { maxWidth = 800, maxHeight = 800, quality = 0.8 } = {}
) => {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Invalid file type. Please upload an image.');
  }

  if (file.type === 'image/gif') return file;

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

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.max(1, Math.round(width * ratio));
          height = Math.max(1, Math.round(height * ratio));
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

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
