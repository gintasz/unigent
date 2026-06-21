export function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 6) {
    return truncateEnd(value, maxLength);
  }
  const sideLength = Math.floor((maxLength - 3) / 2);
  const endLength = maxLength - 3 - sideLength;
  return `${value.slice(0, sideLength)}...${value.slice(value.length - endLength)}`;
}
