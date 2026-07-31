extends Node

func _ready() -> void:
    DevMateQA.set_value("fixture.ready", true)
    DevMateQA.set_value("fixture.value", 42)
    DevMateQA.checkpoint("fixture_ready", {"value": 42})
    DevMateQA.finish(true, "fixture_complete", {"value": 42})
