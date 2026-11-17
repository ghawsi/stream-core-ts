import { kyra_t_parameter, kyra_parameter } from "../../types/types";
import { ATTRIBUTE } from "../../constants/constants";
export abstract class cl_param_container {
  public static readonly mc_range_sign = "SIGN";
  public static readonly mc_range_option = "OPTION";
  public static readonly mc_range_low = "LOW";
  public static readonly mv_range_high = "HIGH";

  protected mt_params: kyra_t_parameter = [];

  public constructor(it_params: kyra_t_parameter) {
    this.mt_params = it_params;
  }
  public get_params(): kyra_t_parameter | undefined {
    this.parse_from_object();
    return this.mt_params;
  }
  public set_params(it_params: kyra_t_parameter) {
    this.mt_params = it_params;
  }
  public get_parameter(iv_param: kyra_parameter): string | undefined {
    const lv_parameter = this.mt_params?.find(
      (row) => row.param === iv_param && row.attribute === ATTRIBUTE.LOW,
    );
    return lv_parameter?.value;
  }
  public set_parameter(iv_param: kyra_parameter, iv_value: string): void {
    if (iv_value !== "") {
      // Equivalent to: READ TABLE mt_params ASSIGNING <ls_param> WITH KEY param = iv_param.
      const ls_param = this.mt_params.find((row) => row.param === iv_param);

      if (ls_param) {
        // Equivalent to: IF sy-subrc = 0. <ls_param>-value = iv_value.
        ls_param.value = iv_value;
      } else {
        // Equivalent to: ELSE. APPEND INITIAL LINE TO me->mt_params ASSIGNING <ls_param> ...
        this.mt_params.push({
          client: "",
          entityId: "",
          EntityType: "",
          param: iv_param,
          attribute: ATTRIBUTE.LOW,
          unifier: 1,
          value: iv_value,
        });
      }
    }
  }
  public get_range(){}
  public set_range(){}
  public get_table() {}
  public set_table() {}
  public set_parameter_string() {}
  public get_all_params() {}
  public set_fieldtable() {}
  public get_fieldtable() {}

  protected abstract parse_from_object(): void;
  protected abstract parse_from_table(): void;
}
