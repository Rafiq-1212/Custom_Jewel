'use client';

import { extensionForDataUrl } from '@/lib/download';
import { ImagePreview } from './ImagePreview';

export function GeneratedImage({ image }: { image: string }) {
  const download = () => {
    const link = document.createElement('a');
    link.href = image;
    link.download = `jewellery-engraving.${extensionForDataUrl(image)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className="flex flex-col gap-3">
      <ImagePreview src={image} alt="Generated jewellery engraving line art" label="Engraving Artwork" />
      <button
        type="button"
        onClick={download}
        className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        Download Preview
      </button>
    </div>
  );
}
