/** A credential field's metadata. Its supplied value never belongs to a public reply. */
export interface TwinInput { name: string; label?: string; secret?: boolean }
/** Non-secret inputs for provisioning, including defaults the person can edit. */
export interface TwinProvisionInput { name: string; label: string; value: string }
export interface TwinProvision { inputs: TwinProvisionInput[] }
export interface TwinProvisioned { expiresAt: string; claimUrl?: string }
export interface TwinInputState extends TwinInput { secret: boolean; help?: string; set: boolean }
export interface TwinServiceInputView {
  id: string; title: string; inputs: TwinInputState[]; provision?: TwinProvision; provisioned?: TwinProvisioned;
}
/** GET/PUT /api/twin/inputs and POST /api/twin/inputs/provision. */
export interface TwinInputsReply { services: TwinServiceInputView[] }
/** A Sandbox stage's services. Unknown fidelity names remain displayable by older clients. */
export interface TwinService {
  id: string; provider?: string; title?: string; fidelity: string; source?: string; blocked?: boolean; missing?: TwinInput[]; keys?: TwinInput[];
  provision?: TwinProvision | null; provisioned?: TwinProvisioned | null;
}
export interface TwinServicesReply { services: TwinService[]; generated: boolean }
