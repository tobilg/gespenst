(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))

  (memory (export "memory") 1)
  (data (i32.const 128) "wasix fixture ok\0a")

  (func $write (param $fd i32) (param $pointer i32) (param $length i32)
    (i32.store (i32.const 0) (local.get $pointer))
    (i32.store (i32.const 4) (local.get $length))
    (drop
      (call $fd_write
        (local.get $fd)
        (i32.const 0)
        (i32.const 1)
        (i32.const 20))))

  (func (export "_start")
    (call $write (i32.const 1) (i32.const 128) (i32.const 17))))
