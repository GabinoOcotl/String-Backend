import type {
  CourseSearchRequest,
  CourseSearchResponse,
  EnrollmentPackage,
  SearchFilter,
} from "../types/enrollment";

const BASE_URL = "https://public.enroll.wisc.edu/api/search/v1";

const DEFAULT_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
} as const;

export const DEFAULT_PAGE_SIZE = 50;
export const OPEN_WAITLISTED_STATUS = "OPEN WAITLISTED";

export class EnrollmentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "EnrollmentApiError";
  }
}

export function openWaitlistedFilter(): SearchFilter {
  return {
    has_child: {
      type: "enrollmentPackage",
      query: {
        match: {
          "packageEnrollmentStatus.status": OPEN_WAITLISTED_STATUS,
        },
      },
    },
  };
}

export function buildSearchRequest(
  termCode: string,
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
): CourseSearchRequest {
  return {
    selectedTerm: termCode,
    queryString: "*",
    filters: [openWaitlistedFilter()],
    page,
    pageSize,
    sortOrder: "SCORE",
  };
}

async function parseJsonResponse<T>(response: Response, url: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new EnrollmentApiError(
      `Enrollment API ${response.status}: ${body || response.statusText}`,
      response.status,
      url,
    );
  }
  return response.json() as Promise<T>;
}

/** Paginated course catalog search (OPEN/WAITLISTED enrollment packages only). */
export async function searchCourses(
  termCode: string,
  page: number,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<CourseSearchResponse> {
  const url = BASE_URL;
  const response = await fetch(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(buildSearchRequest(termCode, page, pageSize)),
  });
  return parseJsonResponse<CourseSearchResponse>(response, url);
}

/** Section/enrollment package details for a single course. */
export async function fetchEnrollmentPackages(
  termCode: string,
  subjectCode: string,
  courseId: string,
): Promise<EnrollmentPackage[]> {
  const url = `${BASE_URL}/enrollmentPackages/${termCode}/${subjectCode}/${courseId}`;
  const response = await fetch(url, {
    method: "GET",
    headers: DEFAULT_HEADERS,
  });
  return parseJsonResponse<EnrollmentPackage[]>(response, url);
}
