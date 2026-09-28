import { Router, type IRouter } from "express";
import healthRouter from "./health";
import deepkrak3nRouter from "./deepkrak3n";

const router: IRouter = Router();

router.use(healthRouter);
router.use(deepkrak3nRouter);

export default router;
