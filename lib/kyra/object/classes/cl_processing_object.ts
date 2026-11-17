import { cl_param_container } from "../../common/classes/cl_param_container";
import { kyra_object_id } from "../../types/types";
// Optional helper to enforce the AS4TAB 30-character max length
type TabName = string;

abstract class cl_processing_object {
  public static potype_source = "S";
  public static potype_target = "T";

  public constructor(
    io_param: cl_param_container,
    iv_structure_read: TabName,
    iv_structure_write: TabName,
    iv_filter: boolean,
  ) {
    this.mv_structure_read = iv_structure_read;
    this.mv_structure_write = iv_structure_write;
    this.mv_filter = iv_filter;
  }

  public abstract read(): void;
  public abstract write<et_object_id = kyra_object_id>(): et_object_id[];

public get_fieldcat(){};
public set_data(){};
public get_data(){};
public get_comm_stuc(){};
public get_version(){};
public get_param(){};

  //Protected section
  protected md_data: unknown;
  // protected mo_param: cl_param_proc_obj;
  // protected mt_fieldName: kyra_t_fieldName;
  protected mv_filter: boolean;
  protected filter_data(){};

  //Private section
  private mv_structure_read: TabName;
  private mv_structure_write: TabName;
}
