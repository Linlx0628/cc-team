### 段：Go

> 本段适用于 `*.go`。引擎自带的 Go 清单会自动合并生效。

#### 错误处理

- `err` 被忽略（`_` 接收、或赋值后从不检查），导致失败被静默吞掉。
- `defer` 里的 `Close()`/`Rollback()` 返回的 `err` 被丢弃，而该错误代表数据没落盘。
- 在**循环里** `defer`：函数返回前才执行，连接/文件会一直堆积到循环结束。
- 包装错误时把原始错误丢了（`return errors.New(...)` 而没有 `%w`），导致上层无法判断。

#### 并发

- 多个 goroutine 并发写同一个 map：直接 fatal（`concurrent map writes`）。
- goroutine 泄漏：向无人接收的 channel 发送、或 `select` 没有退出分支，协程永久阻塞。
- 向已关闭的 channel 发送、或重复关闭 channel：panic。
- 忘记 `Unlock`（含提前 `return`/`panic` 的路径）、或复制了含 `sync.Mutex` 的结构体。
- 用 `-race` 能发现的数据竞争：共享变量的读写没有同步。

#### 切片与指针陷阱

- 切片共享底层数组：`append` 或切片截取后再改一个，意外影响到另一个。
- 循环变量捕获（Go 1.22 之前 `for` 变量是共享的，闭包/goroutine 里用到会拿到最后一个值）。
- `nil` map 写入：直接 panic（只读的 `nil` map 是安全的）。
- 接口与 `nil`：`var e error = (*T)(nil)` 不等于 `nil`，判空逻辑判断失效。

#### 一致性

- 事务/`defer Rollback` 与手动 `Commit` 混用导致误回滚。
- `context` 没有传递或没有取消，请求取消/超时后下游仍在跑。
- 金额用 `float32`/`float64`；并发累加没有原子性或锁保护。
