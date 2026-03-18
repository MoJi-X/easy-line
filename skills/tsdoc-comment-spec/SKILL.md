---
description: TypeScript注释规范(基于微软TSDoc标准)，用于统一项目中的代码注释风格。
---
# TypeScript 注释规范 (TSDoc)

本项目遵循微软主导的 TSDoc 标准进行 TypeScript 代码的注释。由于 TypeScript 自身拥有强大的静态类型检查，注释的核心原则是**提供附加信息，避免重复声明类型**。

## 1. 核心原则
- **不写类型**：绝对不要在 `@param` 或 `@returns` 中重复写出已经在代码签名中定义的类型。
- **文档注释使用 `/** ... */`**：暴露给外部或需要 IDE 提示的类、接口、函数、属性，必须使用 `/** */`。
- **普通注释使用 `//`**：用于解释代码内部逻辑、TODO 或 Hack，不要使用 `/* */`。

## 2. 函数/方法注释规范
只需描述“作用”和“参数含义”，省略类型。

```typescript
/**
 * 获取指定用户的详细信息。
 * 
 * @remarks
 * 这是一个开销较大的操作，内部会进行多次数据库查询，避免在循环中频繁调用。
 * 
 * @param userId - 用户的唯一标识符
 * @param includeDeleted - 是否包含已注销的用户，默认为 false
 * @returns 用户的聚合数据结构。如果用户不存在则抛出 UserNotFoundError。
 * 
 * @throws {@link UserNotFoundError} 当用户在数据库中找不到时
 */
async function getUserProfile(userId: string, includeDeleted: boolean = false): Promise<UserProfile> {
  // ...
}
```

## 3. 接口与对象属性注释
对于 interface 和 type，应对暴露给外部的属性加上 `/** */` 注释。

```typescript
export interface AppConfig {
  /** 
   * 服务监听的端口号，通常是 8080 
   */
  port: number;
  
  /** 
   * 数据库连接字符串
   * @deprecated 推荐使用 `databaseOptions` 替代此字段 
   */
  dbUrl: string;
}
```

## 4. 常用 TSDoc 标签
- `@param <name> - <description>`: 描述参数（注意中间用 `-` 分隔）。
- `@returns <description>`: 描述返回值（仅在返回内容不明显时使用）。
- `@deprecated <message>`: 标记废弃，必须说明替代方案。
- `@remarks`: 用于补充详细的实现细节。
- `@example`: 提供使用代码示例。
- `@see`: 提供参考链接或指向其他代码实体的链接 (`{@link MyClass}`)。
- `@internal`: 标记系统内部使用的 API，防止外部误用。

## 5. 项目落地要求
在后续的编码过程中，所有的基础工具类、核心业务逻辑服务（Services）、以及公共组件等，必须严格按照此规范添加 TSDoc 注释。不得在注释中出现类似 `@param {string} xxx` 的旧版 JSDoc 类型声明风格。
