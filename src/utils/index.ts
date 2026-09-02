import { ColorUtils } from "./color.utils.js";
import { JwtUtils } from "./jwt.utils.js";
import { TimeUtils } from "./time.utils.js";
import { UserUtils } from "./user.utils.js";

class Utils {
  private static instance: Utils;

  public time: TimeUtils;
  public user: UserUtils;
  public jwt: JwtUtils;
  public color: ColorUtils;

  private constructor() {
    this.time = TimeUtils.getInstance();
    this.user = UserUtils.getInstance();
    this.jwt = JwtUtils.getInstance();
    this.color = ColorUtils.getInstance();
  }

  static getInstance(): Utils {
    if (!Utils.instance) {
      Utils.instance = new Utils();
    }
    return Utils.instance;
  }
}

export const utils = Utils.getInstance();
