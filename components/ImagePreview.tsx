export function ImagePreview({
  src,
  alt,
  label,
}: {
  src: string;
  alt: string;
  label: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="block h-auto w-full object-contain" />
      </div>
    </div>
  );
}
