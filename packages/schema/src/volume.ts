export interface Volume {
  id: string;
  name: string;
  sizeGb: number;
  location: string;
  status: "available" | "attached";
  attachedTo: string | null;
}
