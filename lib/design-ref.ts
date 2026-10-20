/** The short name a design goes by on the shop's cart and order, e.g. "TT-8F0C21": from the end of its folder's hash. */
export function designRef(folder: string | null | undefined): string {
  return folder ? `TT-${folder.slice(-6).toUpperCase()}` : '';
}
