function baseFolder(): string {
  return process.env.CLOUDINARY_BASE_FOLDER ?? "ai-campaign-banner";
}

export function campaignFolder(campaignId: string): string {
  return `${baseFolder()}/campaigns/${campaignId}`;
}

export function elementsFolder(campaignId: string): string {
  return `${campaignFolder(campaignId)}/elements`;
}

export function finalsFolder(campaignId: string): string {
  return `${campaignFolder(campaignId)}/finals`;
}
