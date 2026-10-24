/** 面向用户的可读错误：直接显示给用户，不写日志堆栈。 */
export class UserFacingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UserFacingError';
    }
}
