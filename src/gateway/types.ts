export interface GatewayModel {
  id: string;
  object?: "model";
  owned_by?: string;
}

export interface GatewayBackend {
  listModels(): Promise<GatewayModel[]>;
  /** Pass through one OpenAI-compatible request and return a standard Response. */
  handle(request: Request, model: string): Promise<Response>;
}
