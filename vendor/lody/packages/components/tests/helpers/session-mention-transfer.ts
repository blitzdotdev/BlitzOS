/**
 * DataTransfer stand-in that lowercases type names the way browsers do — the
 * detail the id-in-the-type-name trick has to survive.
 */
export function createSessionMentionTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none' as string,
    get types() {
      return Array.from(data.keys());
    },
    setData(type: string, value: string) {
      data.set(type.toLowerCase(), value);
    },
    getData(type: string) {
      return data.get(type.toLowerCase()) ?? '';
    },
  };
}
