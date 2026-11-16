export interface S_EAV{
  /** @maxLength 3 (SAP CLNT) */
  client: string;
  /** @maxLength 12 (SAP NUMC) */
  entityId: string;
  /** @maxLength 7 (SAP CHAR) */
  EntityType: string;
  /** @maxLength 30 (SAP CHAR) */
  param: string;
  /** @maxLength 30 (SAP CHAR) */
  attribute: string;
  /** SAP INT4 */
  unifier: number;
  /** SAP STRING */
  value: string;
}

export type kyra_t_parameter = S_EAV[];
export type kyra_parameter = string;