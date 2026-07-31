extends Node2D

var elapsed := 0.0

func _ready() -> void:
    DevMateQA.set_value("capture.ready", true)
    DevMateQA.checkpoint("capture_started")

func _process(delta: float) -> void:
    elapsed += delta
    DevMateQA.set_value("capture.elapsed", elapsed)
    queue_redraw()

func _draw() -> void:
    var x := 320.0 + sin(elapsed * 2.0) * 180.0
    draw_circle(Vector2(x, 180.0), 36.0, Color(0.2, 0.7, 1.0))
