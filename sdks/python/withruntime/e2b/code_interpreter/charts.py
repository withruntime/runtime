"""E2B chart payload models; these describe data, never execute vendor calls."""
from enum import Enum
from typing import Union


class ChartType(str, Enum):
    LINE = "line"
    SCATTER = "scatter"
    BAR = "bar"
    PIE = "pie"
    BOX_AND_WHISKER = "box_and_whisker"
    SUPERCHART = "superchart"
    UNKNOWN = "unknown"


class ScaleType(str, Enum):
    LINEAR = "linear"
    DATETIME = "datetime"
    CATEGORICAL = "categorical"
    LOG = "log"
    SYMLOG = "symlog"
    LOGIT = "logit"
    FUNCTION = "function"
    FUNCTIONLOG = "functionlog"
    ASINH = "asinh"
    UNKNOWN = "unknown"


class Chart:
    def __init__(self, **values):
        self._raw_data = values
        self.type = ChartType(values["type"] or ChartType.UNKNOWN)
        self.title, self.elements = values["title"], values["elements"]

    def to_dict(self): return self._raw_data


class Chart2D(Chart):
    def __init__(self, **values):
        super().__init__(**values)
        for field in ("x_label", "y_label", "x_unit", "y_unit"):
            setattr(self, field, values[field])


class _Data:
    fields = ()
    def __init__(self, **values):
        for field in self.fields: setattr(self, field, values[field])


class PointData(_Data):
    fields = ("label",)
    def __init__(self, **values):
        super().__init__(**values)
        self.points = [(x, y) for x, y in values["points"]]


class PointChart(Chart2D):
    def __init__(self, **values):
        super().__init__(**values)
        for axis in ("x", "y"):
            try: scale = ScaleType(values.get(axis + "_scale"))
            except ValueError: scale = ScaleType.UNKNOWN
            setattr(self, axis + "_scale", scale)
            for field in ("ticks", "tick_labels"):
                setattr(self, axis + "_" + field, values[axis + "_" + field])
        self.elements = [PointData(**row) for row in values["elements"]]


class LineChart(PointChart): type = ChartType.LINE
class ScatterChart(PointChart): type = ChartType.SCATTER


class BarData(_Data): fields = ("label", "group", "value")
class PieData(_Data): fields = ("label", "angle", "radius")


class BoxAndWhiskerData(_Data):
    fields = ("label", "min", "first_quartile", "median", "third_quartile", "max")
    def __init__(self, **values):
        super().__init__(**values)
        self.outliers = values.get("outliers") or []


class BarChart(Chart2D):
    type = ChartType.BAR
    def __init__(self, **values):
        super().__init__(**values)
        self.elements = [BarData(**row) for row in values["elements"]]


class PieChart(Chart):
    type = ChartType.PIE
    def __init__(self, **values):
        super().__init__(**values)
        self.elements = [PieData(**row) for row in values["elements"]]


class BoxAndWhiskerChart(Chart2D):
    type = ChartType.BOX_AND_WHISKER
    def __init__(self, **values):
        super().__init__(**values)
        self.elements = [BoxAndWhiskerData(**row) for row in values["elements"]]


class SuperChart(Chart):
    type = ChartType.SUPERCHART
    def __init__(self, **values):
        super().__init__(**values)
        self.elements = [chart for row in values["elements"] if (chart := _deserialize_chart(row)) is not None]


ChartTypes = Union[Chart, LineChart, ScatterChart, BarChart, PieChart, BoxAndWhiskerChart, SuperChart]


def _deserialize_chart(data):
    if not data: return None
    kind = {"line": LineChart, "scatter": ScatterChart, "bar": BarChart, "pie": PieChart,
            "box_and_whisker": BoxAndWhiskerChart, "superchart": SuperChart}.get(data["type"], Chart)
    return kind(**data)
