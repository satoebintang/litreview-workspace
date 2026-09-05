import { createReviewServices } from "@/application/services";
import { createDb } from "@/db/client";

const globalForReview = globalThis as unknown as {
  reviewDatabase?: ReturnType<typeof createDb>;
};

const database = globalForReview.reviewDatabase ?? createDb();
if (process.env.NODE_ENV !== "production") globalForReview.reviewDatabase = database;

export const reviewServices = createReviewServices(database.db);
